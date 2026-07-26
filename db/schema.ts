import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull().default(""),
  vehicleYear: text("vehicle_year").notNull().default(""),
  vehicleMake: text("vehicle_make").notNull(),
  vehicleModel: text("vehicle_model").notNull(),
  vehiclePlate: text("vehicle_plate").notNull().default(""),
  laborRateCents: integer("labor_rate_cents").notNull(),
  agreedWork: text("agreed_work").notNull(),
  suggestions: text("suggestions").notNull().default(""),
  status: text("status").notNull().default("draft"),
  receiptsReviewed: integer("receipts_reviewed", { mode: "boolean" })
    .notNull()
    .default(false),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const timeEntries = sqliteTable("time_entries", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  kind: text("kind").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
});

export const materials = sqliteTable("materials", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitCostCents: integer("unit_cost_cents").notNull(),
});

export const receipts = sqliteTable("receipts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  vendor: text("vendor").notNull().default(""),
  amountCents: integer("amount_cents").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  laborCents: integer("labor_cents").notNull(),
  materialsCents: integer("materials_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  recipientEmail: text("recipient_email").notNull().default(""),
  status: text("status").notNull().default("ready"),
  createdAt: text("created_at").notNull(),
});
