/**
 * 独立模式桌宠配置挂载：复用插件设置页 React 组件与同一套宿主配置 API。
 * @module dsh-pet/src/standalone/settings-page/pet-config-mount
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makePetConfigSection } from '../../client/settings.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import { zh } from '../../client/settings/locales/zh.ts';
import type { SettingsRuntime } from '../../client/settings/runtime.ts';

const host = document.getElementById('pet-cards');
if (host !== null) {
  host.dataset.reactMounted = 'true';
  const legacyFooter = document.getElementById('legacy-pet-footer');
  if (legacyFooter instanceof HTMLElement) legacyFooter.hidden = true;
  const runtime: SettingsRuntime = {
    h: jsx,
    useState,
    useEffect,
    useRef,
    useCallback,
    t: (key) => String(zh[key as keyof typeof zh] ?? key),
  };
  const Section = makePetConfigSection(runtime, { get: () => undefined });
  createRoot(host).render(createElement(Section));

  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  let selectedTheme: 'system' | 'light' | 'dark' = 'system';
  const applyTheme = (): void => {
    const dark = selectedTheme === 'dark' || (selectedTheme === 'system' && prefersDark.matches);
    root.dataset.uiTheme = dark ? 'dark' : 'light';
  };
  const refreshTheme = (): void => {
    void fetch(ROUTE_PATH + '/config')
      .then((response) => (response.ok ? response.json() : null))
      .then((config: { main?: { uiTheme?: unknown } } | null) => {
        const theme = config?.main?.uiTheme;
        if (theme === 'light' || theme === 'dark' || theme === 'system') {
          selectedTheme = theme;
          applyTheme();
        }
      })
      .catch(() => {});
  };
  prefersDark.addEventListener('change', applyTheme);
  applyTheme();
  refreshTheme();
  window.setInterval(refreshTheme, 5000);
}
