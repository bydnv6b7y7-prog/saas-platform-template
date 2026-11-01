/** The product name people see. The web build may override it with VITE_BRAND_NAME. */
export const BRAND_NAME = "Northwind";

/**
 * Prefix of identifiers already stored outside the code: pending email-code leases in the database,
 * consent and sidebar choices in browsers, Mastra storage and trace names, analytics product names,
 * and log / database client names that dashboards filter on. Changing it orphans that data, so it keeps
 * its original value; a new project chooses it once (the template exporter does).
 */
export const IDENTIFIER_PREFIX = "northwind";
