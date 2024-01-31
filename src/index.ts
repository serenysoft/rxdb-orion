import { last, pick } from 'lodash';
import { Subject } from 'rxjs';
import {
  RxReplicationState,
  replicateRxCollection,
} from 'rxdb/plugins/replication';
import {
  RxReplicationPullStreamItem,
  RxReplicationWriteToMasterRow,
} from 'rxdb';
import { OrionReplicationOptions } from './types';
import { executeFetch, executePull, executePush } from './helpers';

export const ORION_REPLICATION_PREFIX = 'orion-';

export class Manager {
  constructor(
    private replications: RxReplicationState<any, any>[],
    private delay: number = 10000
  ) {}

  private intervals: NodeJS.Timer[] = [];

  async start(awaitInit = true): Promise<void> {
    if (this.intervals.length) {
      return;
    }

    for (const replicationState of this.replications) {
      await replicationState.start();

      if (awaitInit) {
        await replicationState.awaitInitialReplication();
      }
    }

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
}

export function replicateOrion<RxDocType>({
  url,
  headers,
  params,
  collection,
  modifier,
  batchSize,
  waitForLeadership,
  deletedField = '_deleted',
  updatedField = 'updated_at',
  updatedParam = 'minUpdatedAt',
  wrap = 'data',
  live = true,
  retryTime = 1000 * 5, // in ms
  autoStart = false,
  transporter = executeFetch,
}: OrionReplicationOptions<RxDocType>): RxReplicationState<RxDocType, any> {
  const primaryPath = collection.schema.primaryPath;
  const pullStream$ = new Subject<RxReplicationPullStreamItem<any, any>>();

  const replicationPrimitivesPull = {
    batchSize,
    modifier: modifier?.pull,
    stream$: pullStream$.asObservable(),
    handler: async (lastCheckpoint: any, batchSize: number) => {
      const id = lastCheckpoint?.[primaryPath];
      const updatedAt = lastCheckpoint?.[updatedField];

      const scopes = updatedAt
        ? [{ name: updatedParam, parameters: [updatedAt, id] }]
        : null;

      const result = await executePull({
        url,
        collection,
        headers,
        params,
        batchSize,
        wrap,
        deletedField,
        transporter,
        data: { scopes },
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
    ): Promise<[]> => {
      const result = await executePush({
        url,
        rows,
        headers,
        collection,
        deletedField,
        primaryPath,
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
