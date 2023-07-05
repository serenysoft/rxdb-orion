import { createRxDatabase } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';

const contactSchema = {
  version: 0,
  description: 'Describes a contact',
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
    updated_at: {
      type: 'number',
    },
  },
};

export async function initDatabase() {
  const database = await createRxDatabase({
    name: 'testdb',
    storage: getRxStorageDexie(),
  });

  await database.addCollections({
    contacts: {
      schema: contactSchema,
    },
  });

  return database;
}
