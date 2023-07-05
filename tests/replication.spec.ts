import { RxDatabase } from 'rxdb';
import { AxiosTransporter } from '../src/transporter';
import { initDatabase } from './database';
import { replicateOrion } from '../src';
import axios, { AxiosInstance } from 'axios';
import './replication.mock';

describe('Replication', () => {
  let http: AxiosInstance;
  let transporter: AxiosTransporter;
  let database: RxDatabase;

  beforeEach(async () => {
    database = await initDatabase();
    http = axios.create({ baseURL: 'http://api.fake.test' });
    transporter = new AxiosTransporter(http);
  });

  afterEach(async () => {
    await database.destroy();
  });

  test.skip('Should pull all documents from remote api', async () => {
    const contacts = database.collections.contacts;
    const replicationState = replicateOrion({
      url: '/contacts',
      collection: database.collections.contacts,
      transporter,
      batchSize: 3,
    });

    await replicationState.awaitInitialReplication();
    await replicationState.cancel();

    const result = await contacts.find().exec();
    expect(result.map((contact) => contact.toMutableJSON())).toEqual([
      { id: 10, name: 'Jeff', updated_at: 1 },
      { id: 11, name: 'Mark', updated_at: 2 },
      { id: 12, name: 'Bill', updated_at: 3 },
      { id: 13, name: 'Max', updated_at: 4 },
      { id: 14, name: 'Steve', updated_at: 5 },
    ]);
  });
});
