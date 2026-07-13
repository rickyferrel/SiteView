"use client";

// MPCG marketing landing page, implemented from the "MPCG Landing.dc.html"
// Claude Design comp's Noir art direction. Scroll-reveal, the parcel "sweep"
// wipe, and Ken Burns motion are ported from the comp's DCLogic script
// (including its force-reveal fallback for throttled/hidden
// IntersectionObservers).

import Image from "next/image";
import { useEffect, useRef } from "react";

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
          <Legend />
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

