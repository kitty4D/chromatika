import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";

type MarkdownDocProps = {
  markdown: string;
  className?: string;
};

export function MarkdownDoc({ markdown, className }: MarkdownDocProps) {
  return (
    <div className={className ? `md-doc ${className}` : "md-doc"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => {
            if (href?.startsWith("/")) {
              return (
                <Link to={href} {...rest}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                {children}
              </a>
            );
          },
          pre: ({ children }: { children?: ReactNode }) => (
            <pre className="md-doc-pre">{children}</pre>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
