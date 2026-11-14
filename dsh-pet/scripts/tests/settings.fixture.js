import { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makePetConfigSection, petBridge, dicts } from '../../src/client/settings.ts';

petBridge.current = window.initialConfig.main.pets;
petBridge.template = petBridge.current[0];
const dictionary = new URLSearchParams(location.search).get('lang') === 'zh' ? dicts.zh : dicts.en;
const Section = makePetConfigSection(
  {
    h: jsx,
    useState,
    useEffect,
    useRef,
    useCallback,
    t: (key) => dictionary[key] ?? key,
  },
  { get: () => undefined },
);
createRoot(document.getElementById('root')).render(jsx(Section, {}));
