"use client";

// MPCG marketing landing page, implemented from the "MPCG Landing.dc.html"
// Claude Design comp. Three complete art directions — Noir (default), Ivory,
// Signal — share the same content and are toggled by the floating switcher.
// Scroll-reveal, the parcel "sweep" wipe, and Ken Burns motion are ported
// from the comp's DCLogic script (including its force-reveal fallback for
// throttled/hidden IntersectionObservers).

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
    num: "01",
    title: "Community websites",
    desc: "A digital sales center that never closes — fast, beautiful, and wired to your CRM from day one.",
  },
  {
    num: "02",
    title: "Marketing that moves lots",
    desc: "Brand, launch strategy, and always-on campaigns that fill your pipeline before the models open.",
  },
  {
    num: "03",
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

const STEPS = [
  { num: "01", title: "Immerse", desc: "We learn the land, the buyer, and the numbers before anything gets built." },
  { num: "02", title: "Build", desc: "Brand, website, and SiteView map — one integrated system, not three vendors." },
  { num: "03", title: "Launch", desc: "Campaigns go live. Interest lists become appointments at the sales office." },
  { num: "04", title: "Sell through", desc: "We optimize weekly — pricing, phasing, media — until the last lot closes." },
];

const MARQUEE =
  "SiteView — Interactive 3D parcel mapping  ·  Live availability  ·  Every lot in context  ·  Built on real terrain  ·  ";

type Variant = "noir" | "ivory" | "signal";

export default function MpcgLanding() {
  const [variant, setVariant] = useState<Variant>("noir");
  const rootRef = useRef<HTMLDivElement>(null);

  const pick = (v: Variant) => {
    setVariant(v);
    window.scrollTo({ top: 0 });
  };

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
  }, [variant]);

  return (
    <div ref={rootRef}>
      {variant === "noir" && <Noir key="noir" />}
      {variant === "ivory" && <Ivory key="ivory" />}
      {variant === "signal" && <Signal key="signal" />}

      <div className="mpcg-switch">
        {(["noir", "ivory", "signal"] as const).map((v) => (
          <button key={v} type="button" className={variant === v ? "on" : ""} onClick={() => pick(v)}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

function Brand({ theme }: { theme: "nr" | "iv" | "sg" }) {
  return (
    <div className={`${theme}-brand`}>
      <div className={`${theme}-brand-mark`}>
        MP<span>C</span>G
      </div>
      {theme !== "sg" && <div className={`${theme}-brand-rule`} />}
      <div className={`${theme}-brand-sub`}>MASTER PLAN CONSULTING GROUP</div>
    </div>
  );
}

function Legend({ theme }: { theme: "nr" | "iv" | "sg" }) {
  return (
    <div className={`${theme}-legend`}>
      {STATUSES.map((s) => (
        <div key={s.label} className={`${theme}-legend-item`}>
          <div className={`${theme}-legend-dot`} style={{ background: s.color }} />
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ===================== NOIR ===================== */

function Noir() {
  return (
    <div className="nr">
      <div className="nr-hero">
        <div className="nr-nav">
          <Brand theme="nr" />
          <div className="nr-links">
            <a href="#services" className="nr-link">Services</a>
            <a href="#siteview" className="nr-link">SiteView</a>
            <a href="#process" className="nr-link">Process</a>
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
          <Legend theme="nr" />
        </div>
      </div>

      <div className="nr-band">
        <Image data-kb src={MAP_IMG} alt="SiteView 3D community map" fill sizes="100vw" />
        <div className="nr-band-fade" />
      </div>

      <div id="services" className="nr-services">
        <div className="nr-svc-head">
          <div>
            <div data-reveal={0} className="nr-kick">What we do</div>
            <h2 data-reveal={0.1} className="nr-h2">One team. Everything a sell-out launch needs.</h2>
          </div>
          <p data-reveal={0.2} className="nr-svc-note">No handoffs between vendors. One system, built to move lots.</p>
        </div>
        {SERVICES.map((s, i) => (
          <div key={s.num} data-reveal={i * 0.05} className="nr-svc-row">
            <div className="nr-svc-num">{s.num}</div>
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

      <div id="process" className="nr-process">
        <div data-reveal={0} className="nr-kick">How we work</div>
        <h2 data-reveal={0.1} className="nr-h2">Four steps to sold out.</h2>
        <div className="nr-steps">
          {STEPS.map((s, i) => (
            <div key={s.num} data-reveal={i * 0.08} className="nr-step">
              <div className="nr-step-num">{s.num}</div>
              <div className="nr-step-title">{s.title}</div>
              <div className="nr-step-desc">{s.desc}</div>
            </div>
          ))}
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

/* ===================== IVORY ===================== */

function Ivory() {
  return (
    <div className="iv">
      <div className="iv-nav">
        <Brand theme="iv" />
        <div className="iv-links">
          <a href="#services" className="iv-link">Services</a>
          <a href="#siteview" className="iv-link">SiteView</a>
          <a href="#process" className="iv-link">Process</a>
          <a href="#contact" className="iv-nav-cta">Schedule a consultation</a>
        </div>
      </div>

      <div className="iv-hero">
        <div data-reveal={0} className="iv-kick">The complete marketing package for community developers</div>
        <h1 data-reveal={0.1} className="iv-h1">
          From dirt to
          <br />
          <em>sold out.</em>
        </h1>
        <p data-reveal={0.2} className="iv-lede">
          The brand, the website, the campaigns — anchored by SiteView, an interactive 3D map that turns your
          master plan into your best salesperson.
        </p>
        <div data-reveal={0.3} className="iv-cta-row">
          <a href="#contact" className="iv-btn">Schedule a consultation</a>
          <a href="#siteview" className="iv-ghost">Explore SiteView ↓</a>
        </div>
      </div>
      <div data-reveal={0.35} className="iv-hero-media">
        <div className="iv-hero-card">
          <Image data-kb src={MAP_IMG} alt="SiteView 3D community map" fill sizes="100vw" />
          <div className="iv-hero-chip">
            <i className="mpcg-pulse" />
            <span>Live availability</span>
          </div>
        </div>
      </div>

      <div id="services" className="iv-services">
        <div className="iv-sec-head">
          <div data-reveal={0} className="iv-kick">What we do</div>
          <h2 data-reveal={0.1} className="iv-h2">
            One team. Everything a<br />
            sell-out launch needs.
          </h2>
        </div>
        <div className="iv-svc-grid">
          {SERVICES.map((s, i) => (
            <div key={s.num} data-reveal={i * 0.08}>
              <div className="iv-svc-num">{s.num}</div>
              <div className="iv-svc-rule" />
              <div className="iv-svc-title">{s.title}</div>
              <div className="iv-svc-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div id="siteview" className="iv-siteview">
        <div className="iv-sv-inner">
          <div className="iv-sv-copy">
            <div data-reveal={0} className="iv-kick">SiteView</div>
            <h2 data-reveal={0.1} className="iv-sv-h2">
              Buyers don&apos;t read site plans. <em>They explore them.</em>
            </h2>
            <p data-reveal={0.2} className="iv-sv-lede">
              Every parcel of your community, mapped in 3D on real terrain — with live availability your buyers
              and agents can trust.
            </p>
            <div className="iv-sv-list">
              {SITEVIEW_FEATURES.map((f, i) => (
                <div key={f.title} data-reveal={i * 0.06} className="iv-sv-item">
                  <div className="iv-sv-item-num">{`0${i + 1}`}</div>
                  <div>
                    <div className="iv-sv-item-title">{f.title}</div>
                    <div className="iv-sv-item-desc">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div data-reveal={0.15}>
            <div className="iv-sv-card">
              <Image className="iv-sv-base" src={MAP_IMG} alt="" fill sizes="100vw" />
              <Image data-sweep className="iv-sv-sweep" src={MAP_IMG} alt="SiteView parcel map" fill sizes="100vw" />
            </div>
            <Legend theme="iv" />
          </div>
        </div>
      </div>

      <div id="process" className="iv-process">
        <div className="iv-sec-head">
          <div data-reveal={0} className="iv-kick">How we work</div>
          <h2 data-reveal={0.1} className="iv-h2">Four steps to sold out.</h2>
        </div>
        <div className="iv-steps">
          {STEPS.map((s, i) => (
            <div key={s.num} data-reveal={i * 0.06} className="iv-step">
              <div className="iv-step-num">{s.num}</div>
              <div className="iv-step-title">{s.title}</div>
              <div className="iv-step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div id="contact" className="iv-contact">
        <div className="iv-contact-panel">
          <div>
            <div data-reveal={0} className="iv-contact-kick">Get started</div>
            <h2 data-reveal={0.1} className="iv-contact-h2">
              Let&apos;s sell <em>your</em> community.
            </h2>
            <p data-reveal={0.2} className="iv-contact-lede">
              Tell us about your project. We&apos;ll come back within one business day with a point of view — and a plan.
            </p>
            <div data-reveal={0.3} className="iv-info">
              <div className="iv-info-row">
                <div className="iv-info-label">Email</div>
                <div className="iv-info-value">hello@mpcg.co</div>
              </div>
              <div className="iv-info-row">
                <div className="iv-info-label">Phone</div>
                <div className="iv-info-value">(801) 555-0134</div>
              </div>
            </div>
          </div>
          <div data-reveal={0.2} className="iv-form">
            <div className="iv-form-pair">
              <input placeholder="Name" className="iv-field" />
              <input placeholder="Email" className="iv-field" />
            </div>
            <input placeholder="Company" className="iv-field" />
            <input placeholder="Project location" className="iv-field" />
            <textarea placeholder="Tell us about the community" rows={4} className="iv-field" />
            <button type="button" className="iv-form-btn">Schedule a consultation</button>
          </div>
        </div>
      </div>

      <div className="iv-footer">
        <Image src="/mpcg-logo.png" alt="MPCG — Master Plan Consulting Group" width={262} height={64} className="iv-footer-logo" />
        <div className="iv-footer-tag">Strategy. Communities. Results.</div>
        <div className="iv-footer-copy">© 2026 Master Plan Consulting Group</div>
      </div>
    </div>
  );
}

/* ===================== SIGNAL ===================== */

function Signal() {
  return (
    <div className="sg">
      <div className="sg-nav">
        <Brand theme="sg" />
        <div className="sg-links">
          <a href="#services" className="sg-link">Services</a>
          <a href="#siteview" className="sg-link">SiteView</a>
          <a href="#process" className="sg-link">Process</a>
          <a href="#contact" className="sg-nav-cta">Schedule a consultation</a>
        </div>
      </div>

      <div className="sg-hero">
        <h1 data-reveal={0} className="sg-h1">
          From dirt
          <br />
          to <span>sold out.</span>
        </h1>
        <div className="sg-hero-row">
          <p data-reveal={0.15} className="sg-lede">
            The complete marketing package for community developers — brand, website, campaigns, and SiteView,
            an interactive 3D map that sells lots while you sleep.
          </p>
          <a data-reveal={0.25} href="#contact" className="sg-btn">Schedule a consultation ↗</a>
        </div>
      </div>
      <div data-reveal={0.2} className="sg-band">
        <Image data-kb src={MAP_IMG} alt="SiteView 3D community map" fill sizes="100vw" />
      </div>
      <div className="sg-marq">
        <div className="sg-marq-track">
          <div>{MARQUEE + MARQUEE}</div>
          <div>{MARQUEE + MARQUEE}</div>
        </div>
      </div>

      <div id="services" className="sg-section">
        <div className="sg-sec-head">
          <div data-reveal={0} className="sg-kick">What we do</div>
          <h2 data-reveal={0.1} className="sg-h2">
            One team.
            <br />
            Zero handoffs.
          </h2>
        </div>
        {SERVICES.map((s, i) => (
          <div key={s.num} data-reveal={i * 0.05} className="sg-svc-row">
            <div className="sg-svc-inner">
              <div className="sg-svc-num">{s.num}</div>
              <div>
                <div className="sg-svc-title">{s.title}</div>
                <div className="sg-svc-desc">{s.desc}</div>
              </div>
              <div className="sg-svc-arrow">↗</div>
            </div>
          </div>
        ))}
      </div>

      <div id="siteview" className="sg-section">
        <div className="sg-sv-head">
          <div>
            <div data-reveal={0} className="sg-kick">The map</div>
            <h2 data-reveal={0.1} className="sg-h2">SiteView</h2>
          </div>
          <p data-reveal={0.2} className="sg-sv-note">
            Buyers don&apos;t read site plans. They explore them — every parcel, on real terrain, with availability
            that&apos;s never stale.
          </p>
        </div>
        <div className="sg-sv-stage">
          <iframe
            data-reveal={0}
            src={EMBED_URL}
            allow="geolocation"
            loading="lazy"
            title="Summit Creek"
            className="sg-sv-iframe"
          />
          <div className="sg-sv-caption">
            <div className="sg-sv-caption-lead">
              <div className="sg-sv-caption-title">Every parcel. Live.</div>
              <div className="sg-sv-caption-note">This is the real thing — click, drag, and explore.</div>
            </div>
            <Legend theme="sg" />
          </div>
        </div>
      </div>

      <div id="process" className="sg-section">
        <div className="sg-sec-head">
          <div data-reveal={0} className="sg-kick">How we work</div>
          <h2 data-reveal={0.1} className="sg-h2">
            Four steps
            <br />
            to sold out.
          </h2>
        </div>
        <div className="sg-steps">
          <div className="sg-steps-grid">
            {STEPS.map((s, i) => (
              <div key={s.num} data-reveal={i * 0.06} className="sg-step">
                <div className="sg-step-num">{s.num}</div>
                <div className="sg-step-title">{s.title}</div>
                <div className="sg-step-desc">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div id="contact" className="sg-contact">
        <div className="sg-contact-inner">
          <h2 data-reveal={0} className="sg-contact-h2">
            Let&apos;s sell
            <br />
            your community.
          </h2>
          <p data-reveal={0.1} className="sg-contact-lede">
            Tell us about your project. We&apos;ll come back within one business day with a point of view — and a plan.
          </p>
          <div data-reveal={0.2} className="sg-form-grid">
            <input placeholder="Name" className="sg-field" />
            <input placeholder="Email" className="sg-field" />
            <input placeholder="Company" className="sg-field" />
            <input placeholder="Project location" className="sg-field" />
          </div>
          <div data-reveal={0.3} className="sg-contact-row">
            <button type="button" className="sg-contact-btn">Schedule a consultation ↗</button>
            <div className="sg-contact-info">hello@mpcg.co&nbsp;&nbsp;·&nbsp;&nbsp;(801) 555-0134</div>
          </div>
        </div>
      </div>

      <div className="sg-footer">
        <div className="sg-footer-mark">
          MP<span>C</span>G
        </div>
        <div className="sg-footer-tag">Strategy. Communities. Results.</div>
        <div className="sg-footer-copy">© 2026 Master Plan Consulting Group</div>
      </div>
    </div>
  );
}
