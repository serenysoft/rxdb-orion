import nock from 'nock';

nock('http://api.fake.push')
  .post('/users/search')
  .query({ page: 1, limit: 3 })
  .reply(200, { data: [] })
  .post('/users')
  .reply(200, { data: { id: '1', name: 'Jeff' } })
  .put('/users/1')
  .reply(200, { data: { id: '1', name: 'Bill' } })
  .delete('/users/1')
  .reply(200, { data: { id: '1', name: 'Bill', _deleted: true } })
  .patch('/users/1/roles/sync')
  .times(2)
  .reply(200, [
    {
      attached: ['100', '200'],
      detached: [],
      updated: [],
    },
  ]);

nock('http://api.fake.pull')
  .post('/users/search')
  .query({ page: 1, limit: 3, include: 'roles' })
  .reply(200, {
    data: [
      { id: '10', name: 'Jeff' },
      { id: '11', name: 'Mark' },
    ],
  })
  .post('/users/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [
      { id: '10', name: 'Jeff' },
      { id: '11', name: 'Mark' },
    ],
  })
  .post('/users/10/roles/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [{ id: '100', name: 'Admin' }],
  })
  .post('/users/11/roles/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [{ id: '200', name: 'Editor' }],
  });

nock('http://api.fake.manager')
  .post('/roles/search')
  .query({ page: 1, limit: 3 })
  .times(2)
  .reply(200, {
    data: [
      { id: '20', name: 'Admin' },
      { id: '21', name: 'Editor' },
    ],
  });

nock('http://api.fake.attachments')
  .post('/users/search')
  .query({ page: 1, limit: 3 })
  .reply(200, { data: [] })
  .post('/users')
  .reply(200, { data: { id: '1', name: 'Bill' } });
