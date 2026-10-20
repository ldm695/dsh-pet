import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type FunctionComponent, type ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

export interface SettingsHelpProps {
  tip: string;
  end?: boolean;
}

/** One keyboard-accessible help marker and one viewport-clamped tooltip for every settings page. */
export const SettingsHelp: FunctionComponent<SettingsHelpProps> = ({ tip, end = false }) => {
  const marker = useRef<HTMLElement | null>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const anchor = marker.current;
      const tooltip = document.getElementById(tooltipId);
      if (!anchor || !tooltip) return;
      const anchorRect = anchor.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const left = end
        ? Math.min(window.innerWidth - tooltipRect.width - 12, anchorRect.right - tooltipRect.width + 4)
        : Math.max(12, Math.min(anchorRect.left - 4, window.innerWidth - tooltipRect.width - 12));
      const below = anchorRect.top < tooltipRect.height + 20;
      const top = below
        ? Math.min(window.innerHeight - tooltipRect.height - 8, anchorRect.bottom + 8)
        : anchorRect.top - tooltipRect.height - 8;
      setPosition({ left: Math.max(12, left), top: Math.max(8, top) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [end, open, tip, tooltipId]);

  return jsx('span', {
    ref: marker,
    className: 'dsh-pet-cfg__q',
    role: 'img',
    tabIndex: 0,
    'aria-label': tip,
    'aria-describedby': open ? tooltipId : undefined,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => {
      if (document.activeElement !== marker.current) setOpen(false);
    },
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    children: [
      '?',
      open
        ? createPortal(
            jsx('div', {
              id: tooltipId,
              className: 'dsh-pet-cfg__tooltip',
              role: 'tooltip',
              style: position ? { left: position.left, top: position.top } : { visibility: 'hidden', left: 0, top: 0 },
              children: tip,
            }),
            document.body,
            tooltipId,
          )
        : null,
    ],
  });
};

export interface SettingsPageHeaderProps {
  title: string;
  help: string;
  actions?: ReactNode;
}

/** Shared page title and right-aligned action row. */
export const SettingsPageHeader: FunctionComponent<SettingsPageHeaderProps> = ({ title, help, actions }) =>
  jsx('header', {
    className: 'dsh-pet-cfg__pageHeader',
    children: [
      jsx(
        'div',
        {
          className: 'dsh-pet-cfg__titleGroup',
          children: [
            jsx('h1', { className: 'dsh-pet-cfg__title', children: title }, 'title'),
            jsx(SettingsHelp, { tip: help }, 'help'),
          ],
        },
        'title-group',
      ),
      jsx('div', { className: 'dsh-pet-cfg__headerActions', children: actions }, 'actions'),
    ],
  });

export interface SettingsPageTabsProps {
  children: ReactNode;
}

export const SettingsPageTabs: FunctionComponent<SettingsPageTabsProps> = ({ children }) =>
  jsx('nav', { className: 'dsh-pet-cfg__pageTabs', 'aria-label': '设置分类', children });

export interface SettingsPageTabProps {
  label: string;
  active?: boolean;
  href?: string;
  onClick?: () => void;
}

export const SettingsPageTab: FunctionComponent<SettingsPageTabProps> = ({ label, active = false, href, onClick }) => {
  const className = 'dsh-pet-cfg__pageTab' + (active ? ' is-active' : '');
  if (href) {
    return jsx('a', { className, href, 'aria-current': active ? 'page' : undefined, children: label });
  }
  return jsx('button', {
    type: 'button',
    className,
    'aria-pressed': active,
    onClick,
    children: label,
  });
};

export interface SettingsCardHeaderProps {
  title: string;
  id?: string;
  help?: string;
  scope?: string;
  end?: boolean;
  actions?: ReactNode;
}

export const SettingsCardHeader: FunctionComponent<SettingsCardHeaderProps> = ({
  title,
  id,
  help,
  scope,
  end,
  actions,
}) =>
  jsx('div', {
    className: 'dsh-pet-cfg__cardHead',
    children: [
      jsx('h2', { id, className: 'dsh-pet-cfg__cardTitle', children: title }, 'title'),
      help ? jsx(SettingsHelp, { tip: help, end }, 'help') : null,
      scope ? jsx('span', { className: 'dsh-pet-cfg__scope', children: scope }, 'scope') : null,
      actions ? jsx('div', { className: 'dsh-pet-cfg__cardHeadActions', children: actions }, 'actions') : null,
    ],
  });
