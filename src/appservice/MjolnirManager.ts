import { Mjolnir } from "../Mjolnir";
import { Request, WeakEvent, BridgeContext, Bridge, Intent, Logger } from "matrix-appservice-bridge";
import { getProvisionedMjolnirConfig } from "../config";
import PolicyList from "../models/PolicyList";
import { MatrixClient, UserID } from "matrix-bot-sdk";
import { DataStore, MjolnirRecord } from "./datastore";
import { AccessControl } from "./AccessControl";
import { Access } from "../models/AccessControlUnit";
import { randomUUID } from "crypto";
import EventEmitter from "events";
import { MatrixEmitter } from "../MatrixEmitter";
import { Permalinks } from "../commands/interface-manager/Permalinks";
import { MatrixRoomReference } from "../commands/interface-manager/MatrixRoomReference";

const log = new Logger('MjolnirManager');

// FIXME: AAAAAAAAaaaaaaaaaaaaa there's some inconsistency between "mjolnir id" "mjolnirRecord.localpart" and "user if of the mjolnir"
//        all over this file.

/**
 * The MjolnirManager is responsible for:
 * * Provisioning new mjolnir instances.
 * * Starting mjolnirs when the appservice is brought online.
 * * Informing mjolnirs about new events.
 */
export class MjolnirManager {
    private readonly mjolnirs: Map</*the user id of the mjolnir*/string, ManagedMjolnir> = new Map();
    private readonly unstartedMjolnirs: Map</** user id of the mjolnir */string, UnstartedMjolnir> = new Map();

    private constructor(
        private readonly dataStore: DataStore,
        private readonly bridge: Bridge,
        private readonly accessControl: AccessControl
    ) {

    }

    /**
     * Create the mjolnir manager from the datastore and the access control.
     * @param dataStore The data store interface that has the details for provisioned mjolnirs.
     * @param bridge The bridge abstraction that encapsulates details about the appservice.
     * @param accessControl Who has access to the bridge.
     * @returns A new mjolnir manager.
     */
    public static async makeMjolnirManager(dataStore: DataStore, bridge: Bridge, accessControl: AccessControl): Promise<MjolnirManager> {
        const mjolnirManager = new MjolnirManager(dataStore, bridge, accessControl);
        await mjolnirManager.startMjolnirs(await dataStore.list());
        return mjolnirManager;
    }

    /**
     * Creates a new mjolnir for a user.
     * @param requestingUserId The user that is requesting this mjolnir and who will own it.
     * @param managementRoomId An existing matrix room to act as the management room.
     * @param client A client for the appservice virtual user that the new mjolnir should use.
     * @returns A new managed mjolnir.
     */
    public async makeInstance(requestingUserId: string, managementRoomId: string, client: MatrixClient): Promise<ManagedMjolnir> {
        const mxid = await client.getUserId();
        const intentListener = new MatrixIntentListener(mxid);
        const managedMjolnir = new ManagedMjolnir(
            requestingUserId,
            await Mjolnir.setupMjolnirFromConfig(
                client,
                intentListener,
                getProvisionedMjolnirConfig(managementRoomId)
            ),
            intentListener,
        );
        await managedMjolnir.start();
        this.mjolnirs.set(mxid, managedMjolnir);
        this.unstartedMjolnirs.delete(mxid);
        return managedMjolnir;
    }

    /**
     * Gets a mjolnir for the corresponding mxid that is owned by a specific user.
     * @param mjolnirId The mxid of the mjolnir we are trying to get.
     * @param ownerId The owner of the mjolnir. We ask for it explicitly to not leak access to another user's mjolnir.
     * @returns The matching managed mjolnir instance.
     */
    public getMjolnir(mjolnirId: string, ownerId: string): ManagedMjolnir|undefined {
        const mjolnir = this.mjolnirs.get(mjolnirId);
        if (mjolnir) {
            if (mjolnir.ownerId !== ownerId) {
                throw new Error(`${mjolnirId} is owned by a different user to ${ownerId}`);
            } else {
                return mjolnir;
            }
        } else {
            return undefined;
        }
    }

    /**
     * Find all of the mjolnirs that are owned by this specific user.
     * @param ownerId An owner of multiple mjolnirs.
     * @returns Any mjolnirs that they own.
     */
    public getOwnedMjolnirs(ownerId: string): ManagedMjolnir[] {
        // TODO we need to use the database for this but also provide the utility
        // for going from a MjolnirRecord to a ManagedMjolnir.
        // https://github.com/matrix-org/mjolnir/issues/409
        return [...this.mjolnirs.values()].filter(mjolnir => mjolnir.ownerId !== ownerId);
    }

    /**
     * Listener that should be setup and called by `MjolnirAppService` while listening to the bridge abstraction provided by matrix-appservice-bridge.
     */
    public onEvent(request: Request<WeakEvent>, context: BridgeContext) {
        // TODO We need a way to map a room id (that the event is from) to a set of managed mjolnirs that should be informed.
        // https://github.com/matrix-org/mjolnir/issues/412
        [...this.mjolnirs.values()].forEach((mj: ManagedMjolnir) => mj.onEvent(request));
    }

    /**
     * provision a new mjolnir for a matrix user.
     * @param requestingUserId The mxid of the user we are creating a mjolnir for.
     * @returns The matrix id of the new mjolnir and its management room.
     */
    public async provisionNewMjolnir(requestingUserId: string): Promise<[string, string]> {
        const access = this.accessControl.getUserAccess(requestingUserId);
        if (access.outcome !== Access.Allowed) {
            throw new Error(`${requestingUserId} tried to provision a mjolnir when they do not have access ${access.outcome} ${access.rule?.reason ?? 'no reason specified'}`);
        }
        const provisionedMjolnirs = await this.dataStore.lookupByOwner(requestingUserId);
        if (provisionedMjolnirs.length === 0) {
            const mjolnirLocalPart = `mjolnir_${randomUUID()}`;
            const mjIntent = await this.makeMatrixIntent(mjolnirLocalPart);

            const managementRoomId = await mjIntent.matrixClient.createRoom({
                preset: 'private_chat',
                invite: [requestingUserId],
                name: `${requestingUserId}'s mjolnir`,
                power_level_content_override: {
                    users: {
                        [requestingUserId]: 100,
                        // Give the mjolnir a higher PL so that can avoid issues with managing the management room.
                        [await mjIntent.matrixClient.getUserId()]: 101
                    }
                }
            });

            const mjolnir = await this.makeInstance(requestingUserId, managementRoomId, mjIntent.matrixClient);
            await mjolnir.createFirstList(requestingUserId, "list");

            await this.dataStore.store({
                local_part: mjolnirLocalPart,
                owner: requestingUserId,
                management_room: managementRoomId,
            });

            return [mjIntent.userId, managementRoomId];
        } else {
            throw new Error(`User: ${requestingUserId} has already provisioned ${provisionedMjolnirs.length} mjolnirs.`);
        }
    }

    public reportUnstartedMjolnir(code: UnstartedMjolnir.FailCode, cause: any, mjolnirRecord: MjolnirRecord, mxid: string): void {
        this.unstartedMjolnirs.set(mjolnirRecord.local_part, new UnstartedMjolnir(mjolnirRecord, new UserID(mxid), code, cause));
    }

    public getUnstartedMjolnirs(): UnstartedMjolnir[] {
        return [...this.unstartedMjolnirs.values()];
    }

    public findUnstartedMjolnir(localPart: string): UnstartedMjolnir|undefined {
        return [...this.unstartedMjolnirs.values()].find(unstarted => unstarted.mjolnirRecord.local_part === localPart);
    }

    /**
     * Utility that creates a matrix client for a virtual user on our homeserver with the specified loclapart.
     * @param localPart The localpart of the virtual user we need a client for.
     * @returns A bridge intent with the complete mxid of the virtual user and a MatrixClient.
     */
    private async makeMatrixIntent(localPart: string): Promise<Intent> {
        const mjIntent = this.bridge.getIntentFromLocalpart(localPart);
        await mjIntent.ensureRegistered();
        return mjIntent;
    }

    /**
     * Attempt to start a mjolnir, and notify its management room of any failure to start.
     * Will be added to `this.unstartedMjolnirs` if we fail to start it AND it is not already running.
     * @param mjolnirRecord The record for the mjolnir that we want to start.
     */
    public async startMjolnir(mjolnirRecord: MjolnirRecord): Promise<void> {
        // if a mjolnir is in `this.mjonirs` it is started, as if it is present, it is going to be given Matrix events.
        if (this.mjolnirs.has(mjolnirRecord.local_part)) {
            throw new TypeError(`${mjolnirRecord.local_part} is already running, we cannot start it.`);
        }
        const mjIntent = await this.makeMatrixIntent(mjolnirRecord.local_part);
        const access = this.accessControl.getUserAccess(mjolnirRecord.owner);
        if (access.outcome !== Access.Allowed) {
            // Don't await, we don't want to clobber initialization just because we can't tell someone they're no longer allowed.
            mjIntent.matrixClient.sendNotice(mjolnirRecord.management_room, `Your mjolnir has been disabled by the administrator: ${access.rule?.reason ?? "no reason supplied"}`);
            this.reportUnstartedMjolnir(UnstartedMjolnir.FailCode.Unauthorized, access.outcome, mjolnirRecord, mjIntent.userId);
        } else {
            await this.makeInstance(
                mjolnirRecord.owner,
                mjolnirRecord.management_room,
                mjIntent.matrixClient,
            ).catch((e: any) => {
                log.error(`Could not start mjolnir ${mjolnirRecord.local_part} for ${mjolnirRecord.owner}:`, e);
                // Don't await, we don't want to clobber initialization if this fails.
                mjIntent.matrixClient.sendNotice(mjolnirRecord.management_room, `Your mjolnir could not be started. Please alert the administrator`);
                this.reportUnstartedMjolnir(UnstartedMjolnir.FailCode.StartError, e, mjolnirRecord, mjIntent.userId);
            });
        }
    }

    // TODO: We need to check that an owner still has access to the appservice each time they send a command to the mjolnir or use the web api.
    // https://github.com/matrix-org/mjolnir/issues/410
    /**
     * Used at startup to create all the ManagedMjolnir instances and start them so that they will respond to users.
     */
    public async startMjolnirs(mjolnirRecords: MjolnirRecord[]): Promise<void> {
        for (const mjolnirRecord of mjolnirRecords) {
            await this.startMjolnir(mjolnirRecord);
        }
    }
}

export class ManagedMjolnir {
    public constructor(
        public readonly ownerId: string,
        private readonly mjolnir: Mjolnir,
        private readonly matrixEmitter: MatrixIntentListener,
    ) { }

    public async onEvent(request: Request<WeakEvent>) {
        this.matrixEmitter.handleEvent(request.getData());
    }

    public async joinRoom(roomId: string) {
        await this.mjolnir.client.joinRoom(roomId);
    }
    public async addProtectedRoom(roomId: string) {
        await this.mjolnir.addProtectedRoom(roomId);
    }

    public async createFirstList(mjolnirOwnerId: string, shortcode: string) {
        const listRoomId = await PolicyList.createList(
            this.mjolnir.client,
            shortcode,
            [mjolnirOwnerId],
            { name: `${mjolnirOwnerId}'s policy room` }
        );
        const roomRef = MatrixRoomReference.fromPermalink(Permalinks.forRoom(listRoomId));
        await this.mjolnir.addProtectedRoom(listRoomId);
        return await this.mjolnir.policyListManager.watchList(roomRef);
    }

    public get managementRoomId(): string {
        return this.mjolnir.managementRoomId;
    }

    /**
     * Intended to be called by the MjolnirManager to make sure the mjolnir is ready to listen to events.
     * This managed mjolnir should not be informed of any events via `onEvent` until `start` is called.
     */
    public async start(): Promise<void> {
        await this.mjolnir.start();
    }
}

/**
 * This is used to listen for events intended for a single mjolnir that resides in the appservice.
 * This exists entirely because the Mjolnir class was previously designed only to receive events
 * from a syncing matrix-bot-sdk MatrixClient. Since appservices provide a transactional push
 * api for all users on the appservice, almost the opposite of sync, we needed to create an
 * interface for both. See `MatrixEmitter`.
 */
export class MatrixIntentListener extends EventEmitter implements MatrixEmitter {
    constructor(private readonly mjolnirId: string) {
        super()
    }

    public handleEvent(mxEvent: WeakEvent) {
        // These are ordered to be the same as matrix-bot-sdk's MatrixClient
        // They shouldn't need to be, but they are just in case it matters.
        if (mxEvent['type'] === 'm.room.member' &&  mxEvent.state_key === this.mjolnirId) {
            if (mxEvent['content']['membership'] === 'leave') {
                this.emit('room.leave', mxEvent.room_id, mxEvent);
            }
            if (mxEvent['content']['membership'] === 'invite') {
                this.emit('room.invite', mxEvent.room_id, mxEvent);
            }
            if (mxEvent['content']['membership'] === 'join') {
                this.emit('room.join', mxEvent.room_id, mxEvent);
            }
        }
        if (mxEvent.type === 'm.room.message') {
            this.emit('room.message', mxEvent.room_id, mxEvent);
        }
        if (mxEvent.type === 'm.room.tombstone' && mxEvent.state_key === '') {
            this.emit('room.archived', mxEvent.room_id, mxEvent);
        }
        this.emit('room.event', mxEvent.room_id, mxEvent);

    }

    /**
     * To be called by `Mjolnir`.
     */
    public async start() {
        // Nothing to do.
    }

    /**
     * To be called by `Mjolnir`.
     */
    public stop() {
        // Nothing to do.
    }
}

export class UnstartedMjolnir {
    constructor(
        public readonly mjolnirRecord: MjolnirRecord,
        public readonly mxid: UserID,
        public readonly failCode: UnstartedMjolnir.FailCode,
        public readonly cause: any,
    ) {

    }
}

export namespace UnstartedMjolnir {
    export enum FailCode {
        Unauthorized = "Unauthorized",
        StartError = "StartError",
    }
}
