CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`action` text NOT NULL,
	`occurred_at` text NOT NULL,
	`mutation_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_events_mutation_id_unique` ON `job_events` (`mutation_id`);