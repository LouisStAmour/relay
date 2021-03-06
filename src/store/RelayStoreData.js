/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule RelayStoreData
 * @flow
 * @typechecks
 */

'use strict';

var GraphQLQueryRunner = require('GraphQLQueryRunner');
var GraphQLStoreChangeEmitter = require('GraphQLStoreChangeEmitter');
var GraphQLStoreDataHandler = require('GraphQLStoreDataHandler');
var GraphQLStoreRangeUtils = require('GraphQLStoreRangeUtils');
var RelayChangeTracker = require('RelayChangeTracker');
import type {ChangeSet} from 'RelayChangeTracker';
var RelayConnectionInterface = require('RelayConnectionInterface');
import type {GarbageCollectionScheduler} from 'RelayGarbageCollector';
var RelayGarbageCollector = require('RelayGarbageCollector');
var RelayMutationQueue = require('RelayMutationQueue');
import type {
  ClientMutationID,
  DataID,
  NodeRangeMap,
  Records,
  RelayQuerySet,
  RootCallMap,
  UpdateOptions,
} from 'RelayInternalTypes';
var RelayNodeInterface = require('RelayNodeInterface');
var RelayPendingQueryTracker = require('RelayPendingQueryTracker');
var RelayProfiler = require('RelayProfiler');
var RelayQuery = require('RelayQuery');
var RelayQueryTracker = require('RelayQueryTracker');
var RelayQueryWriter = require('RelayQueryWriter');
var RelayRecordStore = require('RelayRecordStore');
import type {CacheManager, CacheReadCallbacks} from 'RelayTypes';

var forEachObject = require('forEachObject');
var invariant = require('invariant');
var generateForceIndex = require('generateForceIndex');
var readRelayDiskCache = require('readRelayDiskCache');
var warning = require('warning');
var writeRelayQueryPayload = require('writeRelayQueryPayload');
var writeRelayUpdatePayload = require('writeRelayUpdatePayload');

var {CLIENT_MUTATION_ID} = RelayConnectionInterface;
var {NODE_TYPE} = RelayNodeInterface;

// The source of truth for application data.
var _instance;

/**
 * @internal
 *
 * Wraps the data caches and associated metadata tracking objects used by
 * GraphQLStore/RelayStore.
 */
class RelayStoreData {
  _cacheManager: ?CacheManager;
  _cachedRecords: Records;
  _cachedRootCallMap: RootCallMap;
  _cachedStore: RelayRecordStore;
  _changeEmitter: GraphQLStoreChangeEmitter;
  _garbageCollector: ?RelayGarbageCollector;
  _mutationQueue: RelayMutationQueue;
  _nodeRangeMap: NodeRangeMap;
  _pendingQueryTracker: RelayPendingQueryTracker;
  _records: Records;
  _queuedRecords: Records;
  _queuedStore: RelayRecordStore;
  _recordStore: RelayRecordStore;
  _queryTracker: RelayQueryTracker;
  _queryRunner: GraphQLQueryRunner;
  _rangeData: GraphQLStoreRangeUtils;
  _rootCallMap: RootCallMap;

  /**
   * Get the data set backing actual Relay operations. Used in GraphQLStore.
   */
  static getDefaultInstance(): RelayStoreData {
    if (!_instance) {
      _instance = new RelayStoreData();
    }
    return _instance;
  }

  constructor() {
    const cachedRecords: Records = ({}: $FixMe);
    const cachedRootCallMap: RootCallMap = {};
    const queuedRecords: Records = ({}: $FixMe);
    const records: Records = ({}: $FixMe);
    const rootCallMap: RootCallMap = {};
    const nodeRangeMap: NodeRangeMap = ({}: $FixMe);
    const {
      cachedStore,
      queuedStore,
      recordStore,
    } = createRecordCollection({
      cachedRecords,
      cachedRootCallMap,
      cacheWriter: null,
      queuedRecords,
      nodeRangeMap,
      records,
      rootCallMap,
    });
    const rangeData = new GraphQLStoreRangeUtils();

    this._cacheManager = null;
    this._cachedRecords = cachedRecords;
    this._cachedRootCallMap = cachedRootCallMap;
    this._cachedStore = cachedStore;
    this._changeEmitter = new GraphQLStoreChangeEmitter(rangeData);
    this._mutationQueue = new RelayMutationQueue(this);
    this._nodeRangeMap = nodeRangeMap;
    this._pendingQueryTracker = new RelayPendingQueryTracker(this);
    this._queryRunner = new GraphQLQueryRunner(this);
    this._queryTracker = new RelayQueryTracker();
    this._queuedRecords = queuedRecords;
    this._queuedStore = queuedStore;
    this._records = records;
    this._recordStore = recordStore;
    this._rangeData = rangeData;
    this._rootCallMap = rootCallMap;
  }

  /**
   * Creates a garbage collector for this instance. After initialization all
   * newly added DataIDs will be registered in the created garbage collector.
   * This will show a warning if data has already been added to the instance.
   */
  initializeGarbageCollector(scheduler: GarbageCollectionScheduler): void {
    invariant(
      !this._garbageCollector,
      'RelayStoreData: Garbage collector is already initialized.'
    );
    var shouldInitialize = this._isStoreDataEmpty();
    warning(
      shouldInitialize,
      'RelayStoreData: Garbage collection can only be initialized when no ' +
      'data is present.'
    );
    if (shouldInitialize) {
      this._garbageCollector = new RelayGarbageCollector(this, scheduler);
    }
  }

  /**
   * Sets/clears the cache manager that is used to cache changes written to
   * the store.
   */
  injectCacheManager(cacheManager: ?CacheManager): void {
    const {
      cachedStore,
      queuedStore,
      recordStore,
    } = createRecordCollection({
      cachedRecords: this._cachedRecords,
      cachedRootCallMap: this._cachedRootCallMap,
      cacheWriter: cacheManager ? cacheManager.getQueryWriter() : null,
      queuedRecords: this._queuedRecords,
      nodeRangeMap: this._nodeRangeMap,
      records: this._records,
      rootCallMap: this._rootCallMap,
    });

    this._cacheManager = cacheManager;
    this._cachedStore = cachedStore;
    this._queuedStore = queuedStore;
    this._recordStore = recordStore;
  }

  clearCacheManager(): void {
    const {
      cachedStore,
      queuedStore,
      recordStore,
    } = createRecordCollection({
      cachedRecords: this._cachedRecords,
      cachedRootCallMap: this._cachedRootCallMap,
      cacheWriter: null,
      queuedRecords: this._queuedRecords,
      nodeRangeMap: this._nodeRangeMap,
      records: this._records,
      rootCallMap: this._rootCallMap,
    });

    this._cacheManager = null;
    this._cachedStore = cachedStore;
    this._queuedStore = queuedStore;
    this._recordStore = recordStore;
  }

  hasCacheManager(): boolean {
    return !!this._cacheManager;
  }

  /**
   * Returns whether a given record is affected by an optimistic update.
   */
  hasOptimisticUpdate(dataID: DataID): boolean {
    dataID = this.getRangeData().getCanonicalClientID(dataID);
    return this.getQueuedStore().hasOptimisticUpdate(dataID);
  }

  /**
   * Returns a list of client mutation IDs for queued mutations whose optimistic
   * updates are affecting the record corresponding the given dataID. Returns
   * null if the record isn't affected by any optimistic updates.
   */
  getClientMutationIDs(dataID: DataID): ?Array<ClientMutationID> {
    dataID = this.getRangeData().getCanonicalClientID(dataID);
    return this.getQueuedStore().getClientMutationIDs(dataID);
  }

  /**
   * Reads data for queries incrementally from disk cache.
   * It calls onSuccess when all the data has been loaded into memory.
   * It calls onFailure when some data is unabled to be satisfied from disk.
   */
  readFromDiskCache(
    queries: RelayQuerySet,
    callbacks: CacheReadCallbacks
  ): void {
    var cacheManager = this._cacheManager;
    invariant(
      cacheManager,
      'RelayStoreData: `readFromDiskCache` should only be called when cache ' +
      'manager is available.'
    );
    var profile = RelayProfiler.profile('RelayStoreData.readFromDiskCache');
    readRelayDiskCache(
      queries,
      this._queuedStore,
      this._cachedRecords,
      this._cachedRootCallMap,
      cacheManager,
      {
        onSuccess: () => {
          profile.stop();
          callbacks.onSuccess && callbacks.onSuccess();
        },
        onFailure: () => {
          profile.stop();
          callbacks.onFailure && callbacks.onFailure();
        },
      }
    );
  }

  /**
   * Write the results of a query into the base record store.
   */
  handleQueryPayload(
    query: RelayQuery.Root,
    response: {[key: string]: mixed},
    forceIndex: ?number
  ): void {
    var profiler = RelayProfiler.profile('RelayStoreData.handleQueryPayload');
    var changeTracker = new RelayChangeTracker();
    var writer = new RelayQueryWriter(
      this._cachedStore,
      this._queryTracker,
      changeTracker,
      {
        forceIndex,
        updateTrackedQueries: true,
      }
    );
    writeRelayQueryPayload(
      writer,
      query,
      response
    );
    this._handleChangedAndNewDataIDs(changeTracker.getChangeSet());
    profiler.stop();
  }

  /**
   * Write the results of an update into the base record store.
   */
  handleUpdatePayload(
    operation: RelayQuery.Operation,
    payload: {[key: string]: mixed},
    {configs, isOptimisticUpdate}: UpdateOptions
  ): void {
    var profiler = RelayProfiler.profile('RelayStoreData.handleUpdatePayload');
    var changeTracker = new RelayChangeTracker();
    var store;
    if (isOptimisticUpdate) {
      var clientMutationID = payload[CLIENT_MUTATION_ID];
      invariant(
        typeof clientMutationID === 'string',
        'RelayStoreData.handleUpdatePayload(): Expected optimistic payload ' +
        'to have a valid `%s`.',
        CLIENT_MUTATION_ID
      );
      store = this.getRecordStoreForOptimisticMutation(clientMutationID);
    } else {
      store = this._getRecordStoreForMutation();
    }
    var writer = new RelayQueryWriter(
      store,
      this._queryTracker,
      changeTracker,
      {
        forceIndex: generateForceIndex(),
        isOptimisticUpdate,
        updateTrackedQueries: false,
      }
    );
    writeRelayUpdatePayload(
      writer,
      operation,
      payload,
      {configs, isOptimisticUpdate}
    );
    this._handleChangedAndNewDataIDs(changeTracker.getChangeSet());
    profiler.stop();
  }

  /**
   * Given a query fragment and a data ID, returns a root query that applies
   * the fragment to the object specified by the data ID.
   */
  buildFragmentQueryForDataID(
    fragment: RelayQuery.Fragment,
    dataID: DataID
  ): RelayQuery.Root {
    if (GraphQLStoreDataHandler.isClientID(dataID)) {
      const path = this._queuedStore.getPathToRecord(dataID);
      invariant(
        path,
        'RelayStoreData.buildFragmentQueryForDataID(): Cannot refetch ' +
        'record `%s` without a path.',
        dataID
      );
      return path.getQuery(fragment);
    }
    // Fragment fields cannot be spread directly into the root because they
    // may not exist on the `Node` type.
    return RelayQuery.Root.build(
      fragment.getDebugName() || 'UnknownQuery',
      RelayNodeInterface.NODE,
      dataID,
      [fragment],
      {identifyingArgName: RelayNodeInterface.ID},
      NODE_TYPE
    );
  }

  getNodeData(): Records {
    return this._records;
  }

  getQueuedData(): Records {
    return this._queuedRecords;
  }

  clearQueuedData(): void {
    forEachObject(this._queuedRecords, (_, key) => {
      delete this._queuedRecords[key];
      this._changeEmitter.broadcastChangeForID(key);
    });
  }

  getCachedData(): Records {
    return this._cachedRecords;
  }

  getGarbageCollector(): ?RelayGarbageCollector {
    return this._garbageCollector;
  }

  getMutationQueue(): RelayMutationQueue {
    return this._mutationQueue;
  }

  /**
   * Get the record store with only the cached and base data (no queued data).
   */
  getCachedStore(): RelayRecordStore {
    return this._cachedStore;
  }

  /**
   * Get the record store with full data (cached, base, queued).
   */
  getQueuedStore(): RelayRecordStore {
    return this._queuedStore;
  }

  /**
   * Get the record store with only the base data (no queued/cached data).
   */
  getRecordStore(): RelayRecordStore {
    return this._recordStore;
  }

  getQueryTracker(): RelayQueryTracker {
    return this._queryTracker;
  }

  getQueryRunner(): GraphQLQueryRunner {
    return this._queryRunner;
  }

  getChangeEmitter(): GraphQLStoreChangeEmitter {
    return this._changeEmitter;
  }

  getChangeEmitter(): GraphQLStoreChangeEmitter {
    return this._changeEmitter;
  }

  getRangeData(): GraphQLStoreRangeUtils {
    return this._rangeData;
  }

  getPendingQueryTracker(): RelayPendingQueryTracker {
    return this._pendingQueryTracker;
  }

  /**
   * @deprecated
   *
   * Used temporarily by GraphQLStore, but all updates to this object are now
   * handled through a `RelayRecordStore` instance.
   */
  getRootCallData(): RootCallMap {
    return this._rootCallMap;
  }

  _isStoreDataEmpty(): boolean {
    return (
      Object.keys(this._records).length === 0 &&
      Object.keys(this._queuedRecords).length === 0 &&
      Object.keys(this._cachedRecords).length === 0
    );
  }

  /**
   * Given a ChangeSet, broadcasts changes for updated DataIDs
   * and registers new DataIDs with the garbage collector.
   */
  _handleChangedAndNewDataIDs(changeSet: ChangeSet): void {
    var updatedDataIDs = Object.keys(changeSet.updated);
    updatedDataIDs.forEach(id => this._changeEmitter.broadcastChangeForID(id));
    if (this._garbageCollector) {
      var createdDataIDs = Object.keys(changeSet.created);
      var garbageCollector = this._garbageCollector;
      createdDataIDs.forEach(dataID => garbageCollector.register(dataID));
    }
  }

  _getRecordStoreForMutation(): RelayRecordStore {
    var records = this._records;
    var rootCallMap = this._rootCallMap;

    return new RelayRecordStore(
      ({records}: $FixMe),
      ({rootCallMap}: $FixMe),
      (this._nodeRangeMap: $FixMe),
      this._cacheManager ?
        this._cacheManager.getMutationWriter() :
        null
    );
  }

  getRecordStoreForOptimisticMutation(
    clientMutationID: ClientMutationID
  ): RelayRecordStore {
    var cachedRecords = this._cachedRecords;
    var cachedRootCallMap = this._cachedRootCallMap;
    var rootCallMap = this._rootCallMap;
    var queuedRecords = this._queuedRecords;
    var records = this._records;

    return new RelayRecordStore(
      ({cachedRecords, queuedRecords, records}: $FixMe),
      ({cachedRootCallMap, rootCallMap}: $FixMe),
      (this._nodeRangeMap: $FixMe),
      null, // don't cache optimistic data
      clientMutationID
    );
  }
}

function createRecordCollection({
  cachedRecords,
  cachedRootCallMap,
  cacheWriter,
  queuedRecords,
  nodeRangeMap,
  records,
  rootCallMap,
}): {
  cachedStore: RelayRecordStore,
  queuedStore: RelayRecordStore,
  recordStore: RelayRecordStore
} {
  return {
    queuedStore: new RelayRecordStore(
      ({cachedRecords, queuedRecords, records}: $FixMe),
      ({cachedRootCallMap, rootCallMap}: $FixMe),
      (nodeRangeMap: $FixMe)
    ),
    cachedStore: new RelayRecordStore(
      ({cachedRecords, records}: $FixMe),
      ({cachedRootCallMap, rootCallMap}: $FixMe),
      (nodeRangeMap: $FixMe),
      cacheWriter
    ),
    recordStore: new RelayRecordStore(
      ({records}: $FixMe),
      ({rootCallMap}: $FixMe),
      (nodeRangeMap: $FixMe),
      cacheWriter
    ),
  };
}

RelayProfiler.instrumentMethods(RelayStoreData.prototype, {
  handleQueryPayload: 'RelayStoreData.prototype.handleQueryPayload',
  handleUpdatePayload: 'RelayStoreData.prototype.handleUpdatePayload',
});

module.exports = RelayStoreData;
