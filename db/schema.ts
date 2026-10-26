import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const settings=sqliteTable('settings',{id:integer('id').primaryKey(),value:text('value').notNull()});
export const customers=sqliteTable('customers',{
 id:text('id').primaryKey(),phone:text('phone').notNull().unique(),name:text('name').notNull(),passwordHash:text('password_hash').notNull(),
 recoveryHash:text('recovery_hash').notNull(),createdAt:text('created_at').notNull(),wechat:text('wechat').notNull().default(''),disabled:integer('disabled').notNull().default(0),profile:text('profile').notNull().default('{}'),profileVersion:integer('profile_version').notNull().default(1)
});
export const sessions=sqliteTable('sessions',{
 tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull(),role:text('role').notNull(),expires:text('expires').notNull(),lastActive:text('last_active').notNull().default(''),idleExempt:integer('idle_exempt').notNull().default(0)
},t=>[index('session_user').on(t.userId),index('session_expiry').on(t.expires)]);
export const attempts=sqliteTable('attempts',{id:integer('id').primaryKey({autoIncrement:true}),key:text('key').notNull(),createdAt:text('created_at').notNull()},t=>[index('attempt_key_time').on(t.key,t.createdAt),index('attempt_cleanup').on(t.createdAt)]);
export const orders=sqliteTable('orders',{
 id:integer('id').primaryKey({autoIncrement:true}),publicId:text('public_id').notNull().unique(),userId:text('user_id').notNull(),
 idemHash:text('idem_hash').notNull().unique(),payloadHash:text('payload_hash').notNull(),name:text('name').notNull(),phone:text('phone').notNull(),wechat:text('wechat').notNull().default(''),
 pickup:text('pickup').notNull(),pickupInfo:text('pickup_info').notNull(),note:text('note').notNull().default(''),session:text('session').notNull(),date:text('date').notNull(),slot:text('slot').notNull(),
 items:text('items').notNull(),subtotal:integer('subtotal').notNull(),tax:integer('tax').notNull(),fee:integer('fee').notNull(),total:integer('total').notNull(),
 phase:text('phase').notNull().default('draft'),payment:text('payment').notNull().default('unpaid'),fulfillment:text('fulfillment').notNull().default('pending'),
 channel:text('channel').notNull().default(''),payer:text('payer').notNull().default(''),transactionId:text('transaction_id').notNull().default(''),
 receipt:text('receipt'),arrivalPhoto:text('arrival_photo'),receivedAmount:integer('received_amount'),receivedCurrency:text('received_currency'),exchangeBasis:text('exchange_basis'),
 verifiedBy:text('verified_by'),verifiedAt:text('verified_at'),submittedAt:text('submitted_at'),source:text('source').notNull().default('customer'),
 version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),prep:text('prep').notNull().default('{}'),closedAt:text('closed_at'),mediaRemovedAt:text('media_removed_at')
},t=>[index('order_user').on(t.userId),index('order_date_phase').on(t.date,t.phase),index('order_receipt').on(t.receipt),index('order_arrival').on(t.arrivalPhoto)]);
export const events=sqliteTable('events',{
 id:integer('id').primaryKey({autoIncrement:true}),orderId:integer('order_id').notNull().references(()=>orders.id),actor:text('actor').notNull(),action:text('action').notNull(),note:text('note').notNull().default(''),createdAt:text('created_at').notNull()
},t=>[index('event_order').on(t.orderId,t.id),index('event_action').on(t.action,t.id)]);
export const guards=sqliteTable('tx_guards',{id:text('id').primaryKey(),ok:integer('ok').notNull()},t=>[check('must_match_version',sql`${t.ok}=1`)]);
export const challenges=sqliteTable('challenges',{id:text('id').primaryKey(),ipHash:text('ip_hash').notNull(),answerHash:text('answer_hash').notNull(),createdAt:integer('created_at').notNull(),expires:integer('expires').notNull()},t=>[index('challenge_expiry').on(t.expires)]);
export const orderHistory=sqliteTable('order_history',{id:integer('id').primaryKey(),userId:text('user_id').notNull(),date:text('date').notNull(),slot:text('slot').notNull(),items:text('items').notNull(),pickup:text('pickup').notNull(),pickupName:text('pickup_name').notNull(),archivedAt:text('archived_at').notNull()},t=>[index('history_user').on(t.userId,t.id)]);
export const mediaGarbage=sqliteTable('media_garbage',{key:text('key').primaryKey(),createdAt:text('created_at').notNull(),attempts:integer('attempts').notNull().default(0),lastError:text('last_error').notNull().default('')});
export const cleanupPlans=sqliteTable('cleanup_plans',{tokenHash:text('token_hash').primaryKey(),sessionHash:text('session_hash').notNull(),orders:text('orders').notNull(),archiveHash:text('archive_hash').notNull(),createdAt:text('created_at').notNull(),expires:text('expires').notNull(),completedAt:text('completed_at')});
