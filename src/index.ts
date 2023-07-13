import { last, pick } from 'lodash';
import {
  RxReplicationState,
  replicateRxCollection,
} from 'rxdb/plugins/replication';
import { RxReplicationWriteToMasterRow } from 'rxdb';
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

    await Promise.all(
      this.replications.map(async (replicationState) => {
        await replicationState.start();

        if (awaitInit) {
          await replicationState.awaitInitialReplication();
        }

        this.intervals.push(
          setInterval(() => replicationState.reSync(), this.delay)
        );
      })
    );
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

  const replicationPrimitivesPull = {
    batchSize,
    modifier: modifier?.pull,
    handler: async (lastPulledCheckpoint: any, batchSize: number) => {
      const updated = lastPulledCheckpoint?.[updatedField];
      const scopes = updated
        ? [{ name: updatedParam, parameters: [updated] }]
        : null;

      const result = await executePull({
        url,
        collection,
        headers,
        params,
        batchSize,
        wrap,
        transporter,
        data: { scopes },
      });

      const lastDoc = last(result);
      const checkpoint = lastDoc
        ? pick(lastDoc, [primaryPath, updatedField])
        : lastPulledCheckpoint;

      return {
        documents: result,
        checkpoint: checkpoint,
      };
    },
  };

  const replicationPrimitivesPush = {
    batchSize,
    modifier: modifier?.push,
    handler: (
      rows: RxReplicationWriteToMasterRow<RxDocType>[]
    ): Promise<[]> => {
      return executePush({
        url,
        rows,
        headers,
        collection,
        deletedField,
        primaryPath,
        transporter,
      });
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
