/** This product's analytics events, merged into the platform contract (@northwind/analytics). */
declare module "@northwind/analytics" {
  interface ProductAnalyticsEvents {
    note_created: { source: "page" | "assistant"; has_attachment: boolean };
  }
}

export {};
