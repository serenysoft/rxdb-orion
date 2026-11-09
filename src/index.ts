import { last, pick } from 'lodash';
import { Subject, filter, firstValueFrom, from, race } from 'rxjs';
import {
  RxReplicationState,
  replicateRxCollection,
} from 'rxdb/plugins/replication';
import {
  RxReplicationPullStreamItem,
  RxReplicationWriteToMasterRow,
  WithDeleted,
} from 'rxdb';
import { ManagerError, PREFIX_ORION, OrionReplicationOptions } from './types';
import {
  checkRowError,
  executeFetch,
  executePull,
  executePush,
} from './helpers';

export * from './types';

/**
 * Replications that must be fully synced before a dependent replication
 * starts. Populated by `dependsOn` in `replicateOrion` and consumed by the
 * `Manager` to order the initial sync across related collections.
 */
const replicationDependencies = new WeakMap<
  RxReplicationState<any, any>,
  RxReplicationState<any, any>[]
>();

async function waitForDependencies(
  replicationState: RxReplicationState<any, any>,
  dependencies?: RxReplicationState<any, any>[],
): Promise<void> {
  if (!dependencies?.length) {
    return;
  }

  await firstValueFrom(
    race(
      from(
        Promise.all(dependencies.map((dependency) => dependency.awaitInSync())),
      ),
      replicationState.canceled$.pipe(filter(Boolean)),
    ),
  );
}

export class Manager {
  private intervals: NodeJS.Timeout[] = [];
  private initialSyncFinished: boolean = false;
  private starting: Promise<void> | null = null;
  private startError: Error | null = null;

  private readonly errorSubject = new Subject<ManagerError>();
  readonly errors$ = this.errorSubject.asObservable();

  constructor(
    private replications: RxReplicationState<any, any>[],
    private delay: number = 10000,
  ) {
    this.replications.forEach((replicationState) => {
      replicationState.error$.subscribe((error) => {
        this.errorSubject.next({ replicationState, error });
      });
    });
  }

  async start(): Promise<void> {
    if (this.intervals.length) {
      return;
    }

    for (const replicationState of this.replications) {
      this.intervals.push(
        setInterval(() => {
          if (
            replicationState.wasStarted &&
            !replicationState.isStoppedOrPaused() &&
            !replicationState.subjects.active.getValue()
          ) {
            replicationState.reSync();
          }
        }, this.delay),
      );
    }

    if (!this.starting) {
      this.startError = null;
      this.starting = this.startInBackground();
    }
  }

  async stop(): Promise<void> {
    while (this.intervals.length) {
      clearInterval(this.intervals.pop());
    }
  }

  async cancel(): Promise<void> {
    await this.stop();
    await Promise.all(
      this.replications.map((replicationState) => replicationState.cancel()),
    );
  }

  async awaitInSync(): Promise<void> {
    await this.starting;
    if (this.startError) {
      throw this.startError;
    }
    await Promise.all(
      this.replications.map((replicationState) =>
        replicationState.awaitInSync(),
      ),
    );
  }

  async awaitInitialSync(): Promise<void> {
    if (this.initialSyncFinished) {
      return;
    }

    await this.starting;
    if (this.startError) {
      throw this.startError;
    }
    await Promise.all(
      this.replications.map((replicationState) =>
        replicationState.awaitInitialReplication(),
      ),
    );
    this.initialSyncFinished = true;
  }

  isInitialSyncFinished(): boolean {
    return this.initialSyncFinished;
  }

  private async startInOrder(): Promise<void> {
    const starts = new Map<RxReplicationState<any, any>, Promise<void>>();
    await Promise.all(
      this.replications.map((state) =>
        this.startWithDependencies(state, starts, new Set()),
      ),
    );
  }

  private async startInBackground(): Promise<void> {
    try {
      await this.startInOrder();
    } catch (error) {
      const value = error as {
        replicationState?: RxReplicationState<any, any>;
      };

      this.startError =
        error instanceof Error ? error : new Error(String(error));

      await this.stop();
      this.errorSubject.next({
        error: this.startError,
        replicationState: value?.replicationState,
      });
    } finally {
      this.starting = null;
    }
  }

  private async startWithDependencies(
    replicationState: RxReplicationState<any, any>,
    starts: Map<RxReplicationState<any, any>, Promise<void>>,
    ancestors: Set<RxReplicationState<any, any>>,
  ): Promise<void> {
    if (replicationState.wasStarted) {
      return;
    }

    if (ancestors.has(replicationState)) {
      const error = new Error(
        `Circular dependency detected on replication '${replicationState.replicationIdentifier}'`,
      );

      (error as any).replicationState = replicationState;
      throw error;
    }

    if (starts.has(replicationState)) {
      return starts.get(replicationState);
    }

    const path = new Set(ancestors).add(replicationState);
    const starting = (async () => {
      const dependencies = replicationDependencies.get(replicationState) ?? [];
      await Promise.all(
        dependencies.map(async (dependency) => {
          await this.startWithDependencies(dependency, starts, path);
          await dependency.awaitInitialReplication();
        }),
      );

      try {
        await replicationState.start();
      } catch (error) {
        (error as any).replicationState = replicationState;
        throw error;
      }
    })();
    starts.set(replicationState, starting);
    return starting;
  }
}

export function replicateOrion<RxDocType>({
  url,
  headers,
  params,
  collection,
  modifier,
  batchSize,
  waitForLeadership,
  exclude,
  include,
  deletedField = '_deleted',
  updatedField = 'updated_at',
  updatedParam = 'minUpdatedAt',
  wrap = 'data',
  live = true,
  retryTime = 1000 * 5, // in ms
  autoStart = false,
  transporter = executeFetch,
  rowError = checkRowError,
  dependsOn,
}: OrionReplicationOptions<RxDocType>): RxReplicationState<RxDocType, any> {
  const primaryPath = collection.schema.primaryPath;
  const pullStream$ = new Subject<RxReplicationPullStreamItem<any, any>>();

  const replicationPrimitivesPull = {
    batchSize,
    modifier: modifier?.pull,
    stream$: pullStream$.asObservable(),
    handler: async (lastCheckpoint: any, batchSize: number) => {
      const data = {} as any;

      if (!lastCheckpoint) {
        data.sort = [{ field: updatedField, direction: 'asc' }];
      } else {
        const id = lastCheckpoint[primaryPath];
        const updatedAt = lastCheckpoint[updatedField];
        data.scopes = [{ name: updatedParam, parameters: [updatedAt, id] }];
      }

      const result = await executePull({
        url,
        collection,
        headers,
        params,
        batchSize,
        wrap,
        deletedField,
        transporter,
        exclude: exclude?.pull || [],
        include: include || [],
        data,
      });

      const lastDoc = last(result);
      const checkpoint = lastDoc
        ? pick(lastDoc, [primaryPath, updatedField])
        : lastCheckpoint;

      return {
        documents: result,
        checkpoint,
      };
    },
  };

  const replicationPrimitivesPush = {
    batchSize,
    modifier: modifier?.push,
    handler: async (
      rows: RxReplicationWriteToMasterRow<RxDocType>[],
    ): Promise<WithDeleted<RxDocType>[]> => {
      // Gate the handler itself: initial sync and reSync bypass waitBeforePersist.
      await waitForDependencies(replicationState, dependsOn);
      if (replicationState.isStopped()) {
        return [];
      }
      const result = await executePush({
        url,
        rows,
        headers,
        collection,
        deletedField,
        primaryPath,
        exclude: exclude?.push || [],
        rowError,
        transporter,
      });

      pullStream$.next('RESYNC');
      return result;
    },
  };

  const replicationState = replicateRxCollection({
    replicationIdentifier: PREFIX_ORION + collection.name,
    pull: replicationPrimitivesPull,
    push: replicationPrimitivesPush,
    collection,
    deletedField,
    live,
    retryTime,
    waitForLeadership,
    autoStart,
  });

  if (dependsOn) {
    replicationDependencies.set(replicationState, dependsOn);
  }

  return replicationState;
}
