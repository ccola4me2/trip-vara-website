import { ImageResponse } from "next/og";
import { site } from "@/config/site";

export const alt = `${site.name}, ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social sharing card, generated at build time.
 * Uses system fonts to keep the build free of external font fetches.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #1b3a5f 0%, #0a1a30 100%)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
            color: "#f1705b",
            fontSize: 26,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
          }}
        >
          Trip Vara
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            color: "#ffffff",
            fontSize: 76,
            lineHeight: 1.1,
            maxWidth: 900,
          }}
        >
          Vacations planned by someone who actually answers the phone
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 34,
            color: "#c7d9e9",
            fontSize: 30,
          }}
        >
          {site.tagline}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 44,
            color: "#9db9d5",
            fontSize: 24,
          }}
        >
          {site.advisor.name} &middot; {site.advisor.role} &middot;{" "}
          {site.advisor.affiliation}
        </div>
      </div>
    ),
    size,
  );
}
