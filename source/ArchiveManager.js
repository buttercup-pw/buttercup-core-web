"use strict";

var Buttercup = require("buttercup"),
    StorageInterface = require("__buttercup_web/StorageInterface.js");

var createCredentials = Buttercup.createCredentials,
    DatasourceAdapter = Buttercup.DatasourceAdapter,
    Workspace = Buttercup.Workspace;

var __sharedManager = null;

/**
 * Archive Manager - manages a set of archives for the browser
 */
class ArchiveManager {

    /**
     * Constructor for the manager
     * @param {StorageInterface=} storage Storage interface reference
     */
    constructor(storage) {
        this._archives = {};
        this._storage = storage || StorageInterface;
    }

    /**
     * Archives reference
     * @type {Object}
     */
    get archives() {
        return this._archives;
    }

    /**
     * Archive details for display
     * @typedef {Object} ArchiveDetailsDisplay
     * @property {String} name The name of the item
     * @property {ArchiveStatus} status The status of the item
     * @property {String} type The type of archive connection
     */

    /**
     * Array of archive details ready for display
     * @type {Array.<ArchiveDetailsDisplay>}
     */
    get displayList() {
        const archives = this.archives;
        return Object.keys(archives).map(archiveName => ({
            name: archiveName,
            status: archives[archiveName].status,
            type: archives[archiveName].type
        }));
    }

    /**
     * Storage reference
     * @type {StorageInterface}
     */
    get storage() {
        return this._storage;
    }

    /**
     * Stored archive entry
     * @typedef {Object} ManagedArchiveItem
     * @property {ArchiveStatus} status The status of the item
     * @property {Workspace|undefined} workspace Reference to the workspace (undefined if locked)
     * @property {Credentials|String} credentials Reference to Credentials instance (encrypted string if locked)
     * @property {String|undefined} password The master password (undefined if locked)
     */

    /**
     * Array of unlocked archive items
     * @type {Array.<ManagedArchiveItem>}
     */
    get unlockedArchives() {
        const archives = this.archives;
        return Object.keys(archives)
            .map(archiveName => Object.assign({ name: archiveName }, archives[archiveName]))
            .filter(details => details.status === ArchiveManager.ArchiveStatus.UNLOCKED);
    }

    /**
     * Add an archive to the manager
     * @param {String} archiveName A unique name for the item
     * @param {Workspace} workspace The workspace that holds the archive, datasource etc.
     * @param {Credentials} credentials The credentials for remote storage etc.
     *  (these should also already hold datasource meta information)
     * @param {String} masterPassword The master password
     */
    addArchive(archiveName, workspace, credentials, masterPassword) {
        if (this._archives[archiveName]) {
            throw new Error(`Archive already exists: ${archiveName}`);
        }
        this.archives[archiveName] = {
            status: ArchiveManager.ArchiveStatus.UNLOCKED,
            workspace,
            credentials,
            password: masterPassword,
            type: credentials.type
        };
    }

    /**
     * Check if an item is locked
     * @param {String} archiveName The name of the item
     * @returns {Boolean} True if locked
     * @throws {Error} Throws if the item is not found
     */
    isLocked(archiveName) {
        if (!this.archives[archiveName]) {
            throw new Error(`Archive not found: ${archiveName}`);
        }
        return this.archives[archiveName].status === ArchiveManager.ArchiveStatus.LOCKED;
    }

    /**
     * Load the manager state
     * Used when the page loads to restore the archive items list (all are locked at
     *  this stage).
     */
    loadState() {
        var loadedData = this.storage.getData("archiveManager", { archives: {} });
        this._archives = {};
        for (const archiveName in loadedData.archives) {
            if (loadedData.archives.hasOwnProperty(archiveName)) {
                const { content, type } = loadedData.archives[archiveName];
                this.archives[archiveName] = {
                    status: ArchiveManager.ArchiveStatus.LOCKED,
                    credentials: content,
                    type
                };
            }
        }
    }

    /**
     * Lock an item
     * @param {String} archiveName The name of the item to lock
     * @throws {Error} Throws if the item is not found
     * @throws {Error} Throws if the item is already locked
     * @throws {Error} Throws if the item is currently being processed
     * @returns {Promise} A promise that resolves when the item is locked
     */
    lock(archiveName) {
        if (!this.archives[archiveName]) {
            throw new Error(`Archive not found: ${archiveName}`);
        }
        if (this.isLocked(archiveName)) {
            throw new Error(`Archive already locked: ${archiveName}`);
        }
        let details = this.archives[archiveName];
        if (details.status === ArchiveManager.ArchiveStatus.PROCESSING) {
            throw new Error(`Archive is in processing state: ${archiveName}`);
        }
        details.status = ArchiveManager.ArchiveStatus.PROCESSING;
        return details.credentials
            .toSecureString(details.password)
            .then(function(encContent) {
                details.credentials = encContent;
                delete details.workspace;
                delete details.password;
                details.status = ArchiveManager.ArchiveStatus.LOCKED;
            });
    }

    /**
     * Remove an archive by name
     * @param {String} archiveName The name of the archive to remove
     * @returns {Boolean} True if deleted, false if not found
     */
    removeArchive(archiveName) {
        if (this._archives.hasOwnProperty(archiveName)) {
            delete this._archives[archiveName];
            return true;
        }
        return false;
    }

    /**
     * Save the state of the manager to the storage
     * @returns {Promise} A promise that resolves once the state has been saved
     */
    saveState() {
        var packet = {
                archives: {}
            },
            delayed = [Promise.resolve()];
        Object.keys(this.archives).forEach((archiveName) => {
            const archiveDetails = this.archives[archiveName];
            if (archiveDetails.status === ArchiveManager.ArchiveStatus.LOCKED) {
                packet.archives[archiveName] = {
                    content: archiveDetails.credentials,
                    type: archiveDetails.type
                };
            } else {
                delayed.push(
                    archiveDetails.credentials
                        .toSecureString(archiveDetails.password)
                        .then(function handledConvertedContent(content) {
                            packet.archives[archiveName] = {
                                content,
                                type: archiveDetails.type
                            };
                        })
                );
            }
        });
        return Promise
            .all(delayed)
            .then(() => {
                this.storage.setData("archiveManager", packet);
            });
    }

    /**
     * Unlock a locked item
     * @param {String} archiveName The name of the item to unlock
     * @param {String} password The master password of the item to unlock
     * @throws {Error} Throws if the item is not locked
     * @returns {Promise} A promise that resolves when the item is unlocked
     */
    unlock(archiveName, password) {
        var archiveDetails = this.archives[archiveName];
        if (!this.isLocked(archiveName)) {
            return Promise.resolve(archiveDetails);
        }
        archiveDetails.status = ArchiveManager.ArchiveStatus.PROCESSING;
        return createCredentials
            .fromSecureString(archiveDetails.credentials, password)
            .then((credentials) => {
                if (!credentials) {
                    return Promise.reject(new Error("Failed unlocking credentials: " + archiveName));
                }
                archiveDetails.credentials = credentials;
                archiveDetails.password = password;
                let datasourceInfo = JSON.parse(credentials.getValueOrFail("datasource")),
                    ds = DatasourceAdapter.objectToDatasource(datasourceInfo, credentials);
                if (!ds) {
                    throw new Error("Failed creating datasource - possible corrupt credentials");
                }
                return Promise.all([
                    ds.load(createCredentials.fromPassword(password)),
                    Promise.resolve(ds)
                ]);
            })
            .then(([archive, datasource] = []) => {
                const workspace = new Workspace();
                workspace.setPrimaryArchive(archive, datasource, createCredentials.fromPassword(password));
                archiveDetails.workspace = workspace;
                archiveDetails.status = ArchiveManager.ArchiveStatus.UNLOCKED;
            })
            .catch(function(err) {
                archiveDetails.status = ArchiveManager.ArchiveStatus.LOCKED;
                throw err;
            });
    }

    /**
     * Update workspaces that are unlocked
     * @returns {Promise} A promise that resolves after updating all unlocked workspaces
     */
    updateUnlocked() {
        return Promise.all(
            this.unlockedArchives.map(item => item.workspace
                .localDiffersFromRemote()
                .then(function(differs) {
                    return differs ?
                        item.workspace.mergeSaveablesFromRemote().then(() => true) :
                        false;
                })
                .then(function(save) {
                    // all up to date
                    return save ?
                        item.workspace.save() :
                        null;
                })
            )
        );
    }

}

/**
 * Stored archive status
 * @name ArchiveStatus
 * @enum
 * @memberof ArchiveManager
 * @static
 */
ArchiveManager.ArchiveStatus = {
    LOCKED: "locked",
    UNLOCKED: "unlocked",
    PROCESSING: "processing"
};

/**
 * Get the singleton shared instance
 * @memberof ArchiveManager
 * @static
 * @returns {ArchiveManager} The shared instance
 */
ArchiveManager.getSharedManager = function getSharedManager() {
    if (__sharedManager === null) {
        __sharedManager = new ArchiveManager();
        __sharedManager.loadState();
    }
    return __sharedManager;
};

module.exports = ArchiveManager;
