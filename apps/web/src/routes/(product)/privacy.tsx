import { createFileRoute } from "@tanstack/react-router";

import { AnalyticsConsentSettings } from "@/components/analytics-consent";
import { LegalPage } from "@/components/legal-page";
import { createSeoHead } from "@/lib/seo";

// Placeholder policy describing what the platform itself stores. Have it reviewed for your product
// and jurisdiction. Keep <AnalyticsConsentSettings />: the consent banner links to #analytics-controls.
export const Route = createFileRoute("/(product)/privacy")({
  component: PrivacyPage,
  head: () =>
    createSeoHead({
      title: "Privacy Policy",
      description: "What account data the service stores, why it is needed, and which privacy controls are available.",
      path: "/privacy",
    }),
});

function PrivacyPage() {
  return (
    <LegalPage title="Privacy" summary="What we store, why it is needed, and the controls available to you." effectiveDate="TODO">
      <section><h2>Account data</h2><p>We process your name, email address, the password credential handled by the authentication system, connected sign-in provider identifiers, sessions, and security metadata to provide and protect your account.</p></section>
      <section><h2>Subscriptions</h2><p>Payments are handled by Stripe or Apple. We store subscription status and provider identifiers, never card numbers.</p></section>
      <section><h2>AI assistant</h2><p>When you use the assistant we store your conversations, tool results, and protected operational traces so you can continue them. You can delete conversations at any time.</p></section>
      <section><h2>Feedback</h2><p>Feedback you send, including optional screenshots, is stored to investigate the issue and deleted on a fixed retention schedule.</p></section>
      <AnalyticsConsentSettings />
      <section><h2>Your controls</h2><p>You can delete your account yourself from the account menu (Account → Delete account) at any time.</p></section>
    </LegalPage>
  );
}
