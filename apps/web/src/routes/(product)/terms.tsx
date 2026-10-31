import { createFileRoute } from "@tanstack/react-router";

import { LegalPage } from "@/components/legal-page";
import { createSeoHead } from "@/lib/seo";

// Placeholder terms. Replace with terms reviewed for your product and jurisdiction.
export const Route = createFileRoute("/(product)/terms")({
  component: TermsPage,
  head: () =>
    createSeoHead({
      title: "Terms of Service",
      description: "The terms for using the service, including accounts, subscriptions, and acceptable use.",
      path: "/terms",
    }),
});

function TermsPage() {
  return (
    <LegalPage title="Terms" summary="The rules for using the service." effectiveDate="TODO">
      <section><h2>Service</h2><p>Describe what your product provides.</p></section>
      <section><h2>Accounts and subscriptions</h2><p>Paid plans renew until cancelled through the billing portal or the App Store.</p></section>
      <section><h2>AI-generated content</h2><p>Assistant answers are generated automatically and can be wrong; verify important conclusions.</p></section>
      <section><h2>Questions</h2><p>Add your support contact.</p></section>
    </LegalPage>
  );
}
