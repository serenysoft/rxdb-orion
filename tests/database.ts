import { addRxPlugin, createRxDatabase } from 'rxdb';
import { RxDBAttachmentsPlugin } from 'rxdb/plugins/attachments';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

addRxPlugin(RxDBAttachmentsPlugin);

export const roleSchema = {
  version: 0,
  description: 'The role schema',
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      maxLength: 100,
    },
    name: {
      type: 'string',
    },
  },
};

export const userSchema = {
  version: 0,
  description: 'The user schema',
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      maxLength: 100,
    },
    name: {
      type: 'string',
    },
    roles: {
      type: 'array',
      ref: 'roles',
      items: {
        type: 'string',
      },
    },
  },
  attachments: {
    encrypted: false,
  },
};

export async function initDatabase() {
  const database = await createRxDatabase({
    name: 'testdb',
    storage: getRxStorageMemory(),
  });

  await database.addCollections({
    users: {
      schema: userSchema,
    },
    roles: {
      schema: roleSchema,
    },
  });

  return database;
}
