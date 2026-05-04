type BlocksProps = {
  body: string[];
};

/** shared long-form blocks: paragraphs and simple "-" bullet lists per block. */
export function ArticleBlocks({ body }: BlocksProps) {
  return (
    <div className="article-body">
      {body.map((block, i) => {
        const lines = block.split("\n").map((l) => l.trim());
        const isList = lines.every((l) => l.startsWith("- "));
        if (isList && lines.length > 0) {
          return (
            <ul key={i} className="article-list">
              {lines.map((line, j) => (
                <li key={j}>{line.replace(/^-\s*/, "")}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="article-p">
            {block}
          </p>
        );
      })}
    </div>
  );
}
