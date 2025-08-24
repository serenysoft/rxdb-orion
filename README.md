# [RxDB](https://rxdb.info) - Replication with [Laravel Orion](https://tailflow.github.io/laravel-orion-docs)

[![Build Status](https://github.com/serenysoft/rxdb-orion/actions/workflows/ci.yml/badge.svg)](https://github.com/serenysoft/rxdb-orion/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/serenysoft/rxdb-orion/branch/master/graph/badge.svg?token=GANBHB4ZHS)](https://codecov.io/gh/serenysoft/rxdb-orion)

The Orion replication provides handlers for run replication with Orion REST API as the transportation layer.

## Installation

`npm i rxdb-orion`

## Usage

The package usage is simple, but there are some important rules to follow

### Frontend

- Array properties with ref will be replicated using [`sync` route](https://tailflow.github.io/laravel-orion-docs/v2.x/guide/relationships.html#syncing)
- For other relationship properties, a specific replication will be required for each one.

```typescript
import { replicateOrion } from 'rxdb-orion';
import { userSchema } from './schemas/user';
import { roleSchema } from './schemas/role';

const database = await createRxDatabase({
  name: 'mydb',
  storage: getRxStorageDexie(),
});

await database.addCollections({
  users: {
    schema: userSchema,
  },
  roles: {
    schema: roleSchema,
  },
});

const replicationState = replicateOrion({
  url: 'http://my.fake.api/users',
  params: { include: 'roles' },
  collection: users,
  batchSize: 3,
});

await replicationState.start();
```

#### Manager

It is common for an application to require handling multiple replications.
For this reason, the package includes the `Manager` class to assist in such situations.

As [Laravel Orion](https://tailflow.github.io/laravel-orion-docs) backend is unable to send events to the client,
the **manager** executes `reSync()` every `10000ms` by default.

You can customize the interval as you see fit.

```typescript
import { replicateOrion, Manager } from 'rxdb-orion';

const manager = new Manager([
  replicateOrion({
    url: 'http://my.fake.api/users',
    params: { include: 'roles' },
    collection: users,
    batchSize: 3,
  }),
  replicateOrion({
    url: 'http://my.fake.api/categories',
    collection: categories,
    batchSize: 3,
  }),
], 5000);

await manager.start();
```

### Database

> **Important:**
> To ensure correct replication, define your `created_at`, `updated_at`, and `deleted_at` fields as `timestamp(6)` in your database migrations. This allows storage of milliseconds, which is required for accurate checkpointing and synchronization.

```php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateCategoriesTable extends Migration
{
  public function up()
  {
    Schema::create('categories', function (Blueprint $table) {
      $table->uuid('id')->primary();
      $table->string('name');
      $table->timestamps(6);
      $table->softDeletes(precision: 6);
    });
  }

  public function down()
  {
    Schema::dropIfExists('categories');
  }
}
```

### Model

The package uses a [Scope](https://tailflow.github.io/laravel-orion-docs/v2.x/guide/search.html#filtering) to request all documents that have been written after the given checkpoint.

Therefore, it is recommended to create a trait for making the necessary model customizations.

```php
<?php

namespace App\Traits;

trait Syncable {

    /**
     * Initialize the trait
     *
     * @return void
     */
    protected function initializeSyncable()
    {
        $this->append('_deleted');
    }

    /**
     * Prepare a date for array / JSON serialization.
     *
     * @param  \DateTimeInterface  $date
     * @return string
     */
    protected function serializeDate(DateTimeInterface $date)
    {
        $instance = $date instanceof DateTimeImmutable
            ? CarbonImmutable::instance($date)
            : Carbon::instance($date);

        return $instance->toDateTimeString('millisecond');
    }

    /**
     * Determine if model is deleted
     *
     * @return boolean
     */
    protected function getDeletedAttribute()
    {
        return $this->deleted_at !== null;
    }

    /**
     * Scope a query to only include models changed after given value.
     *
     * @param  \Illuminate\Database\Eloquent\Builder  $query
     * @param  int  $updatedAt
     * @param  string  $id
     * @return \Illuminate\Database\Eloquent\Builder
     */
      public function scopeMinUpdatedAt(Builder $query, string $updatedAt, ?string $id = null): Builder
      {
          return $query->where('updated_at', '>', $updatedAt)
              ->when($id, fn($query) =>
                  $query->orWhere(function($query) use ($updatedAt, $id) {
                      $query->where('updated_at', $updatedAt)->where('id', '>', $id);
                  })
              )
              ->orderBy('updated_at');
      }
}

```

```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class User extends Model {

    use Syncable;

    ....
}
```





