/**
 * minimal chrome for dapp / tx approval popups: wordmark only, no mode switcher or settings.
 */
export function ApprovalTitleBar() {
  return (
    <header className="ct-titleBar ct-titleBar--wallet ct-titleBar--approvalOnly">
      <div className="ct-titleBar-center" style={{ textAlign: 'center' }}>
        chromatika
      </div>
    </header>
  );
}
