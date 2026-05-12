import { Link, Navigate, useParams } from "react-router-dom";
import chromashardMd from "../feature-docs/chromashard.md?raw";
import encryptIkaMd from "../feature-docs/all-encrypt-ika-features.md?raw";
import policyVaultMd from "../feature-docs/policy-vault-deployment.md?raw";
import { rewriteFeatureDocMarkdown, stripFirstMarkdownH1 } from "../lib/feature-doc-rewrite";
import { useDocHead } from "../lib/use-doc-head";
import { MarkdownDoc } from "./MarkdownDoc";

const FEATURE_SLUGS = ["chromashard", "policy-vault", "encrypt-ika"] as const;
export type FeatureDocSlug = (typeof FEATURE_SLUGS)[number];

const FEATURE_MAP: Record<
  FeatureDocSlug,
  {
    markdown: string;
    title: string;
    eyebrow: string;
    summary: string;
    intro?: string;
  }
> = {
  chromashard: {
    markdown: chromashardMd,
    title: "ChromaShard",
    eyebrow: "security & recovery",
    summary:
      "Portable threshold-encrypted recovery: one published string plus a quorum of identity factors, no Chromatika-run coordinator required.",
    intro:
      "ChromaShard is a standalone spec for identity-sharded backup. Chromatika ships the first integration; the mathematics and trust story below are the source of truth once implementation lands.",
  },
  "policy-vault": {
    markdown: policyVaultMd,
    title: "Policy Vault: trust & deploy",
    eyebrow: "on-chain guardrails",
    summary:
      "How Chromatika ships spend caps, panic, rescue, and immutable Move packages for the production cut — and how you can verify claims yourself.",
    intro:
      "This page is the narrative companion to the product UI. Pair it with the task-style user guide and the implementation deep dive in tech guides.",
  },
  "encrypt-ika": {
    markdown: encryptIkaMd,
    title: "Encrypt.xyz + ika feature map",
    eyebrow: "integration atlas",
    summary:
      "Every Chromatika surface that touches encrypt.xyz pre-alpha, ika MPC signing, both, or neither — with pointers into the markdown libraries.",
    intro:
      "Dense reference meant for auditors, integrators, and curious power users — not the first doc you read on day one.",
  },
};

export function isFeatureSlug(s: string | undefined): s is FeatureDocSlug {
  return !!s && (FEATURE_SLUGS as readonly string[]).includes(s);
}

export function FeatureDocPage() {
  const { slug } = useParams();
  const valid = isFeatureSlug(slug);
  const cfg = valid ? FEATURE_MAP[slug] : null;

  const body =
    valid && cfg ? rewriteFeatureDocMarkdown(stripFirstMarkdownH1(cfg.markdown)) : "";

  useDocHead(
    valid && cfg
      ? {
          title: cfg.title,
          description: cfg.summary,
          canonicalPath: `/features/${slug}`,
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "Article",
            headline: cfg.title,
            description: cfg.summary,
            articleSection: cfg.eyebrow,
            author: { "@type": "Organization", name: "Chromatika" },
            publisher: { "@type": "Organization", name: "Chromatika" },
          },
        }
      : { canonicalPath: "/roadmap", jsonLd: null },
  );

  if (!valid || !cfg) {
    return <Navigate to="/roadmap" replace />;
  }

  let crossLinks: { label: string; to: string }[] = [];
  if (slug === "chromashard") {
    crossLinks = [
      { label: "roadmap", to: "/roadmap" },
      { label: "user guide: recover with recovery words", to: "/library/user/recovery-words" },
    ];
  } else if (slug === "policy-vault") {
    crossLinks = [
      { label: "user guide: Policy Vault", to: "/library/user/policy-vault" },
      { label: "tech guide: Policy Vault", to: "/library/tech/policy-vault" },
      { label: "roadmap", to: "/roadmap" },
    ];
  } else {
    crossLinks = [
      { label: "user guide: activity notes", to: "/library/user/activity-notes" },
      { label: "user guide: encrypted dWallet labels", to: "/library/user/encrypted-dwallet-labels" },
      { label: "tech guide: encrypt pre-alpha overview", to: "/library/tech/encrypt-pre-alpha-overview" },
    ];
  }

  return (
    <article className="page-article feature-doc-page">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <Link to="/roadmap">roadmap</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">{cfg.title}</span>
      </nav>

      <header className="article-header feature-doc-header">
        <p className="article-eyebrow">{cfg.eyebrow}</p>
        <h1>{cfg.title}</h1>
        <p className="article-summary">{cfg.summary}</p>
        {cfg.intro ? <p className="feature-doc-intro">{cfg.intro}</p> : null}
        <div className="feature-doc-crosslinks">
          {crossLinks.map((l) => (
            <Link key={l.to} to={l.to} className="feature-doc-pill">
              {l.label}
            </Link>
          ))}
        </div>
      </header>

      <MarkdownDoc markdown={body} className="feature-doc-markdown" />
    </article>
  );
}
