// Share reservations: the share pipeline now inserts a 'pending' row BEFORE
// calling LinkedIn and settles it to 'success' or 'failed' afterward. The
// once-per-person-per-post unique index covers 'pending' too, so a share
// whose outcome was never recorded (a DB error after LinkedIn accepted the
// post, or a restart mid-pipeline) blocks a blind retry instead of letting
// it publish the same post twice.

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE shares DROP CONSTRAINT shares_status_check');
  await knex.raw(
    `ALTER TABLE shares ADD CONSTRAINT shares_status_check CHECK (status IN ('pending','success','failed'))`
  );
  await knex.raw('DROP INDEX idx_shares_once_per_user_post');
  await knex.raw(
    `CREATE UNIQUE INDEX idx_shares_once_per_user_post
       ON shares(post_id, slack_user_id) WHERE status IN ('pending','success')`
  );
};

exports.down = async function down(knex) {
  // The old constraint has no 'pending'; an unsettled reservation's outcome
  // is unknown, so it rolls back as a failed attempt.
  await knex('shares')
    .where({ status: 'pending' })
    .update({ status: 'failed', error_message: 'pending share rolled back by migration' });
  await knex.raw('DROP INDEX idx_shares_once_per_user_post');
  await knex.raw(
    `CREATE UNIQUE INDEX idx_shares_once_per_user_post
       ON shares(post_id, slack_user_id) WHERE status = 'success'`
  );
  await knex.raw('ALTER TABLE shares DROP CONSTRAINT shares_status_check');
  await knex.raw(
    `ALTER TABLE shares ADD CONSTRAINT shares_status_check CHECK (status IN ('success','failed'))`
  );
};
