import type { Asset } from '../api';

/** Renders generated output by type. HTML runs in a sandboxed iframe with no same-origin access. */
export function AssetPreview({ asset }: { asset: Asset }) {
  const ct = asset.content_type;
  let body;
  if (ct.startsWith('image/')) body = <img src={asset.previewUrl} alt={asset.filename} loading="lazy" />;
  else if (ct.startsWith('video/')) body = <video src={asset.previewUrl} controls playsInline />;
  else if (ct.startsWith('audio/')) body = <audio src={asset.previewUrl} controls />;
  else if (ct === 'text/html') body = <iframe src={asset.previewUrl} title={asset.filename} sandbox="allow-scripts allow-pointer-lock" />;
  else body = <p className="muted">{asset.filename} ({Math.ceil(asset.size_bytes / 1024)} KB)</p>;
  return (
    <figure className="asset">
      {body}
      <figcaption>
        <span>{asset.filename}</span>
        <a href={asset.url} download>Download</a>
      </figcaption>
    </figure>
  );
}
