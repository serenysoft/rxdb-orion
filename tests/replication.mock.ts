import nock from 'nock';

nock('http://api.fake.test')
  .post('/contacts/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [
      { id: 10, name: 'Jeff', updated_at: 1 },
      { id: 11, name: 'Mark', updated_at: 2 },
      { id: 12, name: 'Bill', updated_at: 3 },
    ],
  })
  .post('/contacts/search')
  .query({ page: 2, limit: 3 })
  .reply(200, {
    data: [
      { id: 13, name: 'Max', updated_at: 4 },
      { id: 14, name: 'Steve', updated_at: 5 },
    ],
  })
  .post('/contacts/search', {
    scopes: [{ name: 'minUpdatedAt', parameters: [5] }],
  })
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [],
  });
