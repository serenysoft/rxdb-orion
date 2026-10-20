import { last, pick } from 'lodash';
import { Subject } from 'rxjs';
import {
  RxReplicationState,
  replicateRxCollection,
} from 'rxdb/plugins/replication';
import {
  RxReplicationPullStreamItem,
  RxReplicationWriteToMasterRow,
  WithDeleted,
} from 'rxdb';
import { ManagerError, OrionReplicationOptions } from './types';
import {
  checkRowError,
  executeFetch,
  executePull,
  executePush,
} from './helpers';

export * from './types';
export const ORION_REPLICATION_PREFIX = 'orion-';

export class Manager {
  private intervals: NodeJS.Timeout[] = [];
  private initialSyncFinished: boolean = false;

  private readonly errorSubject = new Subject<ManagerError>();
  readonly errors$ = this.errorSubject.asObservable();

  constructor(
    private replications: RxReplicationState<any, any>[],
    private delay: number = 10000
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

    await Promise.all(
      this.replications.map(async (replicationState) => {
        await replicationState.start();
      })
    );

    for (const replicationState of this.replications) {
      this.intervals.push(
        setInterval(() => replicationState.reSync(), this.delay)
      );
    }
  }

  async stop(): Promise<void> {
    while (this.intervals.length) {
      clearInterval(this.intervals.pop());
    }
  }

  async cancel(): Promise<void> {
    await Promise.all(
      this.replications.map((replicationState) => replicationState.cancel())
    );
  }

  async awaitInSync(): Promise<void> {
    await Promise.all(
      this.replications.map((replicationState) =>
        replicationState.awaitInSync()
      )
    );
  }

  async awaitInitialSync(): Promise<void> {
    if (this.initialSyncFinished) {
      return;
    }

    this.initialSyncFinished = false;
    try {
      await Promise.all(
        this.replications.map(async (replicationState) => {
          await replicationState.awaitInitialReplication();
        })
      );
    } finally {
      this.initialSyncFinished = true;
    }
  }

  isInitialSyncFinished(): boolean {
    return this.initialSyncFinished;
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
      rows: RxReplicationWriteToMasterRow<RxDocType>[]
    ): Promise<WithDeleted<RxDocType>[]> => {
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

  return replicateRxCollection({
    replicationIdentifier: ORION_REPLICATION_PREFIX + collection.name,
    pull: replicationPrimitivesPull,
    push: replicationPrimitivesPush,
    collection,
    deletedField,
    live,
    retryTime,
    waitForLeadership,
    autoStart,
  });
}
