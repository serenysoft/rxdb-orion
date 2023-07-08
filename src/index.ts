import { last } from 'lodash';
import { RxReplicationState, replicateRxCollection } from 'rxdb/plugins/replication';
import { RxReplicationWriteToMasterRow } from 'rxdb';
import { OrionReplicationOptions } from './types';
import { executePull, executePush } from './helpers';

export const ORION_REPLICATION_PREFIX = 'orion-';

export * from './transporter';

export function replicateOrion<RxDocType>({
  url,
  collection,
  transporter,
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
}: OrionReplicationOptions<RxDocType>): RxReplicationState<RxDocType, any> {
  const primaryPath = collection.schema.primaryPath;
  const baseUrl = typeof url === 'string' ? { path: url } : url;

  const replicationPrimitivesPull = {
    batchSize,
    modifier: modifier?.pull,
    handler: async (lastPulledCheckpoint: any, batchSize: number) => {
      const updated = lastPulledCheckpoint?.[updatedField];
      const scopes = updated ? [{ name: updatedParam, parameters: [updated] }] : null;

      const result = await executePull({
        baseUrl,
        schema: collection.schema,
        batchSize,
        wrap,
        transporter,
        data: { scopes },
      });

      const lastDoc = last(result);
      const checkpoint = lastDoc
        ? {
            [primaryPath]: lastDoc[primaryPath],
            [updatedField]: lastDoc[updatedField],
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
        baseUrl,
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
