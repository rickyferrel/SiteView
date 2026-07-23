"use client";

// MPCG marketing landing page, implemented from the "MPCG Landing.dc.html"
// Claude Design comp's Noir art direction. Scroll-reveal, the parcel "sweep"
// wipe, and Ken Burns motion are ported from the comp's DCLogic script
// (including its force-reveal fallback for throttled/hidden
// IntersectionObservers).

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

const MAP_IMG = "/mpcg/siteview-map.jpg";
const EMBED_URL = "https://main.d1fccqopge5j62.amplifyapp.com/embed/summit-creek-utah";

const STATUSES = [
  { label: "Available", color: "#86B06A" },
  { label: "Reserved", color: "#D3B04F" },
  { label: "Sold", color: "#A04B4B" },
  { label: "Next phase", color: "#5F7F9E" },
];

const SERVICES = [
  {
    title: "Economic studies",
    desc: "We map the market before you break ground — demand, pricing, absorption, and what the competition down the road is really doing.",
  },
  {
    title: "Community websites",
    desc: "A digital sales center that never closes — fast, beautiful, and wired to your CRM from day one.",
  },
  {
    title: "Marketing that moves lots",
    desc: "Brand, launch strategy, and always-on campaigns that fill your pipeline before the models open.",
  },
  {
    title: "SiteView 3D mapping",
    desc: "Your master plan, alive — an interactive 3D map buyers explore parcel by parcel, phase by phase.",
  },
];

const SITEVIEW_FEATURES = [
  { title: "Live availability", desc: "Statuses flip the moment a lot goes under contract. No stale PDFs." },
  { title: "Every lot, in context", desc: "Acreage, pricing, orientation, and views — one click on any parcel." },
  { title: "Phases made visible", desc: "Show what's selling now and what's coming next — on real terrain." },
  { title: "Lives on your website", desc: "Embeds anywhere. Works on every device your buyers own." },
];

const COMMUNITIES = [
  {
    index: "01",
    name: "Summit Creek",
    location: "Utah",
    slug: "summit-creek-utah",
    embed: "https://main.d1fccqopge5j62.amplifyapp.com/embed/summit-creek-utah",
  },
  {
    index: "02",
    name: "Sand Hollow Resort",
    location: "Southern Utah",
    slug: "sand-hollow-resort",
    embed: "https://main.d1fccqopge5j62.amplifyapp.com/embed/sand-hollow-resort",
  },
  {
    index: "03",
    name: "Seven Mile Ranch",
    location: "Bear Lake, Utah",
    slug: "seven-mile-ranch-bear-lake",
    embed: "https://main.d1fccqopge5j62.amplifyapp.com/embed/seven-mile-ranch-bear-lake",
  },
];


export default function MpcgLanding() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let alive = false;

    const io = new IntersectionObserver(
      (entries) => {
        alive = true;
        entries.forEach((e) => {
          if (e.isIntersecting) {
            const t = e.target as HTMLElement;
            t.style.opacity = "1";
            t.style.transform = "none";
            io.unobserve(t);
          }
        });
      },
      { threshold: 0.12 }
    );
    const sio = new IntersectionObserver(
      (entries) => {
        alive = true;
        entries.forEach((e) => {
          if (e.isIntersecting) {
            const t = e.target as HTMLElement;
            window.setTimeout(() => {
              t.style.clipPath = "inset(0 0% 0 0)";
            }, 200);
            sio.unobserve(t);
          }
        });
      },
      { threshold: 0.3 }
    );

    root.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
      const d = parseFloat(el.dataset.reveal || "0") || 0;
      el.style.opacity = "0";
      el.style.transform = "translateY(26px)";
      el.style.transition = `opacity .9s cubic-bezier(.22,.61,.21,1) ${d}s, transform .9s cubic-bezier(.22,.61,.21,1) ${d}s`;
      io.observe(el);
    });
    root.querySelectorAll<HTMLElement>("[data-sweep]").forEach((el) => {
      el.style.clipPath = "inset(0 100% 0 0)";
      el.style.transition = "clip-path 2.2s cubic-bezier(.65,.05,.25,1)";
      sio.observe(el);
    });

    // If observer callbacks never fire (throttled/hidden iframes), force-
    // reveal everything so content can never stay invisible.
    const fallback = window.setTimeout(() => {
      if (alive) return;
      root.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
        el.style.transition = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      });
      root.querySelectorAll<HTMLElement>("[data-sweep]").forEach((el) => {
        el.style.transition = "none";
        el.style.clipPath = "inset(0 0% 0 0)";
      });
    }, 1500);

    return () => {
      io.disconnect();
      sio.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  return (
    <div ref={rootRef}>
      <Noir />
    </div>
  );
}

function Brand() {
  return (
    <div className="nr-brand">
      <div className="nr-brand-mark">
        MP<span>C</span>G
      </div>
      <div className="nr-brand-rule" />
      <div className="nr-brand-sub">MASTER PLAN CONSULTING GROUP</div>
    </div>
  );
}

function Legend() {
  return (
    <div className="nr-legend">
      {STATUSES.map((s) => (
        <div key={s.label} className="nr-legend-item">
          <div className="nr-legend-dot" style={{ background: s.color }} />
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

/* =================== COMMUNITIES =================== */

function Communities() {
  const [active, setActive] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);

  // Lazy-mount the WebGL embed only as the frame nears the viewport, so a
  // Mapbox GL instance never spins up off-screen. Only the active community's
  // iframe is ever in the DOM (keyed by index) — always exactly one live map.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setMapReady(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMapReady(true);
          io.disconnect();
        }
      },
      { rootMargin: "250px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const choose = (i: number) => {
    if (i === active) return;
    setActive(i);
    setLoading(true);
  };

  const c = COMMUNITIES[active];

  return (
    <div id="communities" className="nr-cm">
      <div className="nr-cm-head">
        <div>
          <div data-reveal={0} className="nr-kick">Communities</div>
          <h2 data-reveal={0.1} className="nr-h2">
            Explore the maps. They&apos;re live.
          </h2>
        </div>
        <p data-reveal={0.2} className="nr-cm-note">
          Pick a community and explore its live SiteView map — the real thing, not a screenshot.
        </p>
      </div>

      <div className="nr-cm-stage">
        <div data-reveal={0} className="nr-cm-switch">
          <div className="nr-cm-switch-label">Select a community</div>
          <div className="nr-cm-entries">
            {COMMUNITIES.map((item, i) => (
              <button
                key={item.slug}
                type="button"
                className="nr-cm-entry"
                data-active={i === active ? "true" : "false"}
                aria-pressed={i === active}
                onClick={() => choose(i)}
              >
                <div className="nr-cm-entry-row">
                  <span className="nr-cm-idx">{item.index}</span>
                  <span className="nr-cm-tick" />
                </div>
                <div className="nr-cm-name">{item.name}</div>
                <div className="nr-cm-loc">{item.location}</div>
              </button>
            ))}
          </div>
          <div className="nr-cm-hint">
            <i />
            <span>Click any lot · drag to explore</span>
          </div>
        </div>

        <div className="nr-cm-view">
          <div ref={frameRef} data-reveal={0.1} className="nr-cm-frame">
            {mapReady ? (
              <iframe
                key={active}
                className="nr-cm-map"
                src={c.embed}
                title={`${c.name} — interactive 3D parcel map, ${c.location}`}
                allow="geolocation"
                loading="lazy"
                onLoad={() => setLoading(false)}
              />
            ) : (
              <div className="nr-cm-idle">
                <span className="nr-cm-idle-dot mpcg-pulse" />
                <span className="nr-cm-idle-text">Loading live map…</span>
              </div>
            )}

            {mapReady && loading && (
              <div className="nr-cm-loading">
                <span className="nr-cm-idle-dot mpcg-pulse" />
                <span className="nr-cm-idle-text">Loading {c.name}…</span>
              </div>
            )}
          </div>

          <div data-reveal={0.15} className="nr-cm-spec">
            <span className="nr-cm-spec-live mpcg-pulse" aria-hidden="true" />
            <span className="nr-cm-spec-name">{c.name}</span>
            <span className="nr-cm-spec-sep" />
            <span className="nr-cm-spec-loc">{c.location}</span>
            <span className="nr-cm-spec-sep" />
            <span className="nr-cm-spec-desc">Interactive 3D parcel map — live availability</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== NOIR ===================== */

function Noir() {
  return (
    <div className="nr">
      <div className="nr-hero">
        <div className="nr-nav">
          <Brand />
          <div className="nr-links">
            <a href="#services" className="nr-link">Services</a>
            <a href="#siteview" className="nr-link">SiteView</a>
            <a href="#communities" className="nr-link">Communities</a>
            <a href="#contact" className="nr-nav-cta">Schedule a consultation</a>
          </div>
        </div>
        <div className="nr-hero-main">
          <div data-reveal={0} className="nr-eyebrow-row">
            <div className="nr-eyebrow-line" />
            <div className="nr-eyebrow">The complete marketing package for community developers</div>
          </div>
          <h1 data-reveal={0.1} className="nr-h1">
            From dirt
            <br />
            to <span>sold out.</span>
          </h1>
          <p data-reveal={0.2} className="nr-lede">
            MPCG builds the brand, the website, and the campaigns — anchored by SiteView, an interactive 3D map
            that turns your master plan into your best salesperson.
          </p>
          <div data-reveal={0.3} className="nr-cta-row">
            <a href="#contact" className="nr-btn">Schedule a consultation</a>
            <a href="#siteview" className="nr-ghost">
              Explore SiteView <span>↓</span>
            </a>
          </div>
        </div>
        <div data-reveal={0.5} className="nr-hero-foot">
          <div className="nr-foot-label">SiteView — interactive 3D parcel mapping</div>
          <Legend />
        </div>
      </div>

      <Communities />

      <div id="services" className="nr-services">
        <div className="nr-svc-head">
          <div>
            <div data-reveal={0} className="nr-kick">What we do</div>
            <h2 data-reveal={0.1} className="nr-h2">One team. Everything a sell-out launch needs.</h2>
          </div>
          <p data-reveal={0.2} className="nr-svc-note">No handoffs between vendors. One system, built to move lots.</p>
        </div>
        {SERVICES.map((s, i) => (
          <div key={s.title} data-reveal={i * 0.05} className="nr-svc-row">
            <div className="nr-svc-title">{s.title}</div>
            <div className="nr-svc-desc">{s.desc}</div>
          </div>
        ))}
      </div>

      <div id="siteview" className="nr-siteview">
        <div className="nr-siteview-inner">
          <div data-reveal={0} className="nr-kick">SiteView</div>
          <h2 data-reveal={0.1} className="nr-sv-h2">Buyers don&apos;t read site plans. They explore them.</h2>
          <p data-reveal={0.2} className="nr-sv-lede">
            Every parcel of your community, mapped in 3D on real terrain — with live availability your buyers
            and agents can trust.
          </p>
          <div data-reveal={0} className="nr-sv-frame">
            <Image className="nr-sv-base" src={MAP_IMG} alt="" fill sizes="100vw" />
            <Image data-sweep className="nr-sv-sweep" src={MAP_IMG} alt="SiteView parcel map with live availability" fill sizes="100vw" />
            <div className="nr-sv-chip">
              <i className="mpcg-pulse" />
              <span>Live availability — updated in real time</span>
            </div>
          </div>
          <div className="nr-features">
            {SITEVIEW_FEATURES.map((f, i) => (
              <div key={f.title} data-reveal={i * 0.08}>
                <div className="nr-feat-line" />
                <div className="nr-feat-title">{f.title}</div>
                <div className="nr-feat-desc">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div id="contact" className="nr-contact">
        <div className="nr-contact-inner">
          <div>
            <div data-reveal={0} className="nr-kick">Get started</div>
            <h2 data-reveal={0.1} className="nr-contact-h2">Let&apos;s sell your community.</h2>
            <p data-reveal={0.2} className="nr-contact-lede">
              Tell us about your project. We&apos;ll come back within one business day with a point of view — and a plan.
            </p>
            <div data-reveal={0.3} className="nr-info">
              <div className="nr-info-row">
                <div className="nr-info-label">Email</div>
                <div className="nr-info-value">hello@mpcg.co</div>
              </div>
              <div className="nr-info-row">
                <div className="nr-info-label">Phone</div>
                <div className="nr-info-value">(801) 555-0134</div>
              </div>
            </div>
          </div>
          <div data-reveal={0.2} className="nr-form">
            <div className="nr-form-pair">
              <input placeholder="Name" className="nr-field" />
              <input placeholder="Email" className="nr-field" />
            </div>
            <input placeholder="Company" className="nr-field" />
            <input placeholder="Project location" className="nr-field" />
            <textarea placeholder="Tell us about the community" rows={4} className="nr-field" />
            <button type="button" className="nr-btn">Schedule a consultation</button>
          </div>
        </div>
      </div>

      <div className="nr-footer">
        <div className="nr-footer-mark">
          MP<span>C</span>G
        </div>
        <div className="nr-footer-tag">Strategy. Communities. Results.</div>
        <div className="nr-footer-copy">© 2026 Master Plan Consulting Group</div>
      </div>
    </div>
  );
}

