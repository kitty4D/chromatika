const GH_DOCS_BASE = "https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs";

/** rewrite local repo paths in copied feature markdown to site routes or github. */
export function rewriteFeatureDocMarkdown(md: string): string {
  let out = md;
  out = out.replace(
    /\]\(\.\.\/\.\.\/wallet-extension\/docs\/([^)]+)\)/gi,
    `](${GH_DOCS_BASE}/$1)`
  );
  out = out.replace(/\]\(\.\.\/wallet-userguides\/([a-z0-9_-]+\.md)\)/gi, (_, f) => {
    const s = f.replace(/\.md$/i, "").toLowerCase();
    return `](/library/user/${s})`;
  });
  out = out.replace(/\]\(\.\.\/wallet-techguides\/([a-z0-9_-]+\.md)\)/gi, (_, f) => {
    const s = f.replace(/\.md$/i, "").toLowerCase();
    return `](/library/tech/${s})`;
  });
  out = out.replace(/\]\(chromashard\.md\)/gi, "](/features/chromashard)");
  out = out.replace(/\]\(policy-vault-deployment\.md\)/gi, "](/features/policy-vault)");
  out = out.replace(/\]\(all-encrypt-ika-features\.md\)/gi, "](/features/encrypt-ika)");
  return out;
}

export function stripFirstMarkdownH1(md: string): string {
  const lines = md.split("\n");
  if (!lines[0]?.startsWith("# ")) return md;
  let i = 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}
