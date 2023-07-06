import { RxReplicationState, replicateRxCollection } from 'rxdb/plugins/replication';
import { RxReplicationWriteToMasterRow } from 'rxdb';
import { OrionOptions, Request } from './types';
import { last, omit } from 'lodash';

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
}: OrionOptions<RxDocType>): RxReplicationState<RxDocType, any> {
  const primaryPath = collection.schema.primaryPath;
  const baseUrl = typeof url === 'string' ? { path: url } : url;

  const replicationPrimitivesPull = {
    batchSize,
    modifier: modifier?.pull,
    handler: async (lastPulledCheckpoint: any, batchSize: number) => {
      const updated = lastPulledCheckpoint?.[updatedField];

      let data;
      let page = 0;
      const result = [];

      do {
        const scopes = updated ? [{ name: updatedParam, parameters: [updated] }] : null;

        const request = {
          method: 'POST',
          action: '/search',
          wrap,
          data: {
            scopes,
          },
          params: {
            page: page + 1,
            limit: batchSize,
          },
          ...baseUrl,
        };

        data = await transporter.execute(request);
        result.push(...data);

        page++;
      } while (data.length === batchSize);

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
    handler: async (rows: RxReplicationWriteToMasterRow<RxDocType>[]): Promise<[]> => {
      const request = omit<Request>(baseUrl, ['params']);

      for (const row of rows) {
        const isNew = !row.assumedMasterState;
        const document = row.newDocumentState as any;

        if (document[deletedField]) {
          request.method = 'DELETE';
          request.key = document[primaryPath];
        } else if (isNew) {
          request.method = 'POST';
          request.data = document;
        } else {
          request.method = 'PUT';
          request.key = document[primaryPath];
          request.data = document;
        }

        await transporter.execute(request);
      }

      return [];
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
