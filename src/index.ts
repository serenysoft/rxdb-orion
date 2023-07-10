import { last } from 'lodash';
import { RxReplicationState, replicateRxCollection } from 'rxdb/plugins/replication';
import { RxReplicationWriteToMasterRow } from 'rxdb';
import { OrionReplicationOptions } from './types';
import { executeFetch, executePull, executePush } from './helpers';

export const ORION_REPLICATION_PREFIX = 'orion-';

export function replicateOrion<RxDocType>({
  url,
  headers,
  collection,
  modifier,
  batchSize,
  waitForLeadership,
  deletedField = '_deleted',
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
      const updated = lastPulledCheckpoint?.updatedAt;
      const scopes = updated ? [{ name: updatedParam, parameters: [updated] }] : null;

      const result = await executePull({
        url,
        schema: collection.schema,
        headers,
        batchSize,
        wrap,
        transporter,
        data: { scopes },
      });

      const lastDoc = last(result);
      const checkpoint = lastDoc
        ? {
            [primaryPath]: lastDoc[primaryPath],
            updatedAt: lastDoc.updatedAt,
          }
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
    handler: (rows: RxReplicationWriteToMasterRow<RxDocType>[]): Promise<[]> => {
      return executePush({
        url,
        rows,
        schema: collection.schema,
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
