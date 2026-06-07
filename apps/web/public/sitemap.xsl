<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <title>Openship - Sitemap</title>
        <meta name="robots" content="noindex"/>
        <style>
          :root {
            --bg: #ffffff;
            --fg: #0a0a0a;
            --muted: rgba(0,0,0,.45);
            --hint: rgba(0,0,0,.32);
            --bd:  rgba(0,0,0,.08);
            --bd-strong: rgba(0,0,0,.14);
            --row-alt: rgba(0,0,0,.018);
            --accent: #00B894;
            --accent-bg: rgba(0,184,148,.08);
          }
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            padding: 0;
            background: var(--bg);
            color: var(--fg);
            font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
            font-size: 14px;
            -webkit-font-smoothing: antialiased;
          }
          .wrap {
            max-width: 1080px;
            margin: 0 auto;
            padding: 56px 24px 80px;
          }
          .brand {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            font-weight: 600;
            font-size: 15px;
            letter-spacing: -0.01em;
            color: var(--fg);
            text-decoration: none;
          }
          .brand-mark {
            width: 22px;
            height: 22px;
            border-radius: 999px;
            border: 2.4px solid currentColor;
          }
          h1 {
            margin: 32px 0 6px;
            font-size: 32px;
            font-weight: 600;
            letter-spacing: -0.025em;
            line-height: 1.15;
          }
          .lede {
            margin: 0 0 36px;
            max-width: 38rem;
            color: var(--muted);
            font-size: 15px;
            line-height: 1.6;
          }
          .meta-bar {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 6px 12px;
            border-radius: 999px;
            background: var(--accent-bg);
            color: var(--accent);
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            margin-bottom: 10px;
          }
          .meta-bar .dot {
            width: 6px;
            height: 6px;
            border-radius: 999px;
            background: var(--accent);
          }
          .count {
            display: inline-block;
            margin-left: 12px;
            color: var(--hint);
            font-size: 13px;
            font-weight: 400;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid var(--bd);
            border-radius: 12px;
            overflow: hidden;
          }
          thead th {
            background: var(--row-alt);
            border-bottom: 1px solid var(--bd);
            text-align: left;
            padding: 12px 16px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
          }
          tbody td {
            border-bottom: 1px solid var(--bd);
            padding: 12px 16px;
            vertical-align: middle;
          }
          tbody tr:last-child td { border-bottom: none; }
          tbody tr:hover { background: var(--row-alt); }
          .url-cell a {
            color: var(--fg);
            text-decoration: none;
            font-weight: 500;
            word-break: break-all;
          }
          .url-cell a:hover { text-decoration: underline; text-underline-offset: 3px; }
          .num   { color: var(--hint); font-variant-numeric: tabular-nums; width: 48px; }
          .when  { color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
          .freq  { color: var(--muted); font-size: 12px; text-transform: lowercase; white-space: nowrap; }
          .pri-cell { width: 90px; }
          .pri-bar {
            position: relative;
            width: 64px;
            height: 6px;
            background: var(--bd);
            border-radius: 999px;
            overflow: hidden;
          }
          .pri-bar .fill {
            position: absolute;
            top: 0; left: 0; bottom: 0;
            background: var(--fg);
            border-radius: 999px;
          }
          .pri-val {
            display: inline-block;
            margin-left: 8px;
            color: var(--muted);
            font-size: 12px;
            font-variant-numeric: tabular-nums;
          }
          footer {
            margin-top: 32px;
            color: var(--hint);
            font-size: 12px;
            line-height: 1.6;
          }
          footer a {
            color: var(--muted);
            text-decoration: none;
            border-bottom: 1px dotted var(--bd-strong);
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <a class="brand" href="/">
            <span class="brand-mark"></span>
            Openship
          </a>

          <xsl:choose>
            <xsl:when test="sm:sitemapindex">
              <div class="meta-bar">
                <span class="dot"></span>
                Sitemap Index
              </div>
              <h1>Sitemap Index<span class="count"><xsl:value-of select="count(sm:sitemapindex/sm:sitemap)"/> sub-sitemaps</span></h1>
              <p class="lede">
                This file lists every sub-sitemap on openship.io. Crawlers fetch each child below to discover the full URL set.
              </p>
              <table>
                <thead>
                  <tr>
                    <th class="num">#</th>
                    <th>Sub-sitemap</th>
                    <th>Last modified</th>
                  </tr>
                </thead>
                <tbody>
                  <xsl:for-each select="sm:sitemapindex/sm:sitemap">
                    <tr>
                      <td class="num"><xsl:value-of select="position()"/></td>
                      <td class="url-cell">
                        <a>
                          <xsl:attribute name="href"><xsl:value-of select="sm:loc"/></xsl:attribute>
                          <xsl:value-of select="sm:loc"/>
                        </a>
                      </td>
                      <td class="when"><xsl:value-of select="substring(sm:lastmod, 1, 10)"/></td>
                    </tr>
                  </xsl:for-each>
                </tbody>
              </table>
            </xsl:when>
            <xsl:otherwise>
              <div class="meta-bar">
                <span class="dot"></span>
                URL Set
              </div>
              <h1>URLs<span class="count"><xsl:value-of select="count(sm:urlset/sm:url)"/> entries</span></h1>
              <p class="lede">
                Every URL below is part of the public Openship site. Crawlers ingest these to keep search results fresh.
              </p>
              <table>
                <thead>
                  <tr>
                    <th class="num">#</th>
                    <th>URL</th>
                    <th>Last modified</th>
                    <th>Freq</th>
                    <th>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  <xsl:for-each select="sm:urlset/sm:url">
                    <tr>
                      <td class="num"><xsl:value-of select="position()"/></td>
                      <td class="url-cell">
                        <a>
                          <xsl:attribute name="href"><xsl:value-of select="sm:loc"/></xsl:attribute>
                          <xsl:value-of select="sm:loc"/>
                        </a>
                      </td>
                      <td class="when"><xsl:value-of select="substring(sm:lastmod, 1, 10)"/></td>
                      <td class="freq"><xsl:value-of select="sm:changefreq"/></td>
                      <td class="pri-cell">
                        <div style="display:flex;align-items:center;">
                          <div class="pri-bar">
                            <div class="fill">
                              <xsl:attribute name="style">width: <xsl:value-of select="number(sm:priority) * 100"/>%</xsl:attribute>
                            </div>
                          </div>
                          <span class="pri-val"><xsl:value-of select="sm:priority"/></span>
                        </div>
                      </td>
                    </tr>
                  </xsl:for-each>
                </tbody>
              </table>
            </xsl:otherwise>
          </xsl:choose>

          <footer>
            <p>
              Following the <a href="https://www.sitemaps.org/protocol.html">sitemaps.org protocol</a>.
              Index lives at <a href="/sitemap.xml">/sitemap.xml</a> ·
              robots: <a href="/robots.txt">/robots.txt</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
