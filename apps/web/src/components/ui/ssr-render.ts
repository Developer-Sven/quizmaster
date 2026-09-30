import { type ComponentType, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Nur für Tests: rendert eine Komponente serverseitig zu HTML. Kinder kommen als eigenes Argument,
 * auch wenn der Props-Typ `children` verlangt.
 */
export function renderHtml<P extends object>(
  component: ComponentType<P>,
  props: Omit<P, "children">,
  ...children: ReactNode[]
): string {
  return renderToStaticMarkup(createElement(component as ComponentType<Omit<P, "children">>, props, ...children));
}
