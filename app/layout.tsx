import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/**
 * One family for body text — the system grotesque, so there is no webfont and
 * no flash. Hierarchy comes from size and weight, which is what a single family
 * is for. The mono face is the only loaded font, and it is reserved for
 * technical metadata: coordinates, formulas, identifiers and figures.
 */
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AquaSite — Water Infrastructure Planner",
  description:
    "Evidence-backed preliminary water infrastructure planning using geospatial intelligence and live research.",
};

/**
 * Inline and synchronous on purpose. A module script is deferred, so applying
 * the theme there would let the browser paint one frame of the light palette
 * first — the flash every dark-mode implementation gets wrong once.
 *
 * The default is "light" rather than "auto": this console is a white surface,
 * and a reader who has not asked for dark should not get it from their OS.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("aquasite-theme");if(t!=="light"&&t!=="dark"&&t!=="auto")t="light";document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t==="auto"?"light dark":t;}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <html
      lang="en"
      data-theme="light"
      className={`${ibmPlexMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      {/* Fixed shell: the page never scrolls, panels scroll internally. */}
      <body className="h-full w-full">{children}</body>
    </html>
  );
}
