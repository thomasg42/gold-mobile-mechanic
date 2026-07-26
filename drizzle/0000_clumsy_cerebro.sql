CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`invoice_number` text NOT NULL,
	`labor_cents` integer NOT NULL,
	`materials_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`recipient_email` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_job_id_unique` ON `invoices` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_invoice_number_unique` ON `invoices` (`invoice_number`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_name` text NOT NULL,
	`customer_email` text DEFAULT '' NOT NULL,
	`vehicle_year` text DEFAULT '' NOT NULL,
	`vehicle_make` text NOT NULL,
	`vehicle_model` text NOT NULL,
	`vehicle_plate` text DEFAULT '' NOT NULL,
	`labor_rate_cents` integer NOT NULL,
	`agreed_work` text NOT NULL,
	`suggestions` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`receipts_reviewed` integer DEFAULT false NOT NULL,
	`started_at` text,
	`ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_cost_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text
);
