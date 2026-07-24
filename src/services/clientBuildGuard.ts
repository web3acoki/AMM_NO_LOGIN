function currentEntryScriptPath(): string | null {
  if (typeof document === 'undefined') return null;
  const entry = [...document.scripts]
    .map(script => script.src)
    .find(src => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(src));
  if (!entry) return null;
  try {
    return new URL(entry, document.baseURI).pathname;
  } catch {
    return null;
  }
}

function entryScriptPathFromHtml(html: string): string | null {
  const match = html.match(/<script\b[^>]*\bsrc=["']([^"']*\/assets\/index-[^"']+\.js[^"']*)["'][^>]*>/i);
  if (!match) return null;
  try {
    return new URL(match[1], location.href).pathname;
  } catch {
    return null;
  }
}

/**
 * Compares the currently executing Vite entry with a no-cache copy of the
 * deployed HTML. A false result means this page is stale and must surrender
 * every task runtime before any later transaction write.
 */
export async function isCurrentClientBuild(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return true;
  const loadedEntry = currentEntryScriptPath();
  if (!loadedEntry) return true;

  const response = await fetch(location.href, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      'Cache-Control': 'no-cache',
    },
  });
  if (!response.ok) throw new Error(`客户端版本检查失败: HTTP ${response.status}`);

  const deployedEntry = entryScriptPathFromHtml(await response.text());
  return !deployedEntry || deployedEntry === loadedEntry;
}
