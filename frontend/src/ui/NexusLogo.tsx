// Nexus brand mark — an original geometric "connection nexus": a central hub
// linked to six orbiting nodes, expressing the agent runtime as a network that
// binds models, tools and context together. Fresh geometry and palette (no
// inherited path/ellipse data, colors or naming from any prior mark).
export function NexusLogo(): JSX.Element {
  // Six nodes evenly placed on a circle of radius R around the center (256,256).
  const cx = 256;
  const cy = 256;
  const R = 150;
  const nodes = Array.from({ length: 6 }, (_, i) => {
    const angle = (-90 + i * 60) * (Math.PI / 180);
    return { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
  });
  return (
    <span className="ds-work-logo ds-work-logo-sm ds-work-logo-phase-trail is-active" aria-hidden="true">
      <span className="ds-nexus-logo-spin-shell">
        <svg
          className="ds-nexus-logo-svg"
          viewBox="0 0 512 512"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          focusable="false"
        >
          <defs>
            <linearGradient id="nexusMarkGradient" x1="96" y1="96" x2="416" y2="416" gradientUnits="userSpaceOnUse">
              <stop stopColor="#5b8def" />
              <stop offset="0.5" stopColor="#7a5cf0" />
              <stop offset="1" stopColor="#22c7c0" />
            </linearGradient>
            <radialGradient id="nexusHubGlow" cx="0.5" cy="0.5" r="0.5">
              <stop stopColor="#a9c4ff" />
              <stop offset="1" stopColor="#5b8def" />
            </radialGradient>
          </defs>
          {/* Links from the hub to each orbiting node. */}
          <g stroke="url(#nexusMarkGradient)" strokeWidth="14" strokeLinecap="round" opacity="0.85">
            {nodes.map((n, i) => (
              <line key={`link-${i}`} x1={cx} y1={cy} x2={n.x} y2={n.y} />
            ))}
          </g>
          {/* Outer ring tracing the orbit. */}
          <circle cx={cx} cy={cy} r={R} stroke="url(#nexusMarkGradient)" strokeWidth="8" opacity="0.35" />
          {/* Orbiting nodes. */}
          <g fill="url(#nexusMarkGradient)">
            {nodes.map((n, i) => (
              <circle key={`node-${i}`} cx={n.x} cy={n.y} r="34" />
            ))}
          </g>
          {/* Central hub. */}
          <circle cx={cx} cy={cy} r="56" fill="url(#nexusHubGlow)" />
          <circle cx={cx} cy={cy} r="56" fill="none" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="4" />
        </svg>
      </span>
    </span>
  );
}
