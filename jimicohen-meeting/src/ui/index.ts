/**
 * The UI kit. Import from here: `import { Button, Field, Input, useToast } from '../ui'`.
 *
 * How the pieces fit
 *  - Scopes (src/lib/theme.tsx). Public screens render inside <ThemeScope theme assets>, which sets
 *    every `--m-*` token (shared/theme.ts lists them) plus data attributes such as data-layout,
 *    data-calendar, data-slots, data-card, data-density on a `.m-scope` wrapper. The dashboard
 *    renders inside <AdminScope>, which uses the `--a-*` tokens from styles/ui.css (light + dark).
 *  - Kit components read only the semantic `--c-*` variables that both scopes define, so the same
 *    Button, Field or Modal looks right in either world. Write shared components against `--c-*`,
 *    public-only CSS against `--m-*`, dashboard-only CSS against `--a-*`.
 *  - Overlays (Modal, Drawer, Menu, Tooltip, Toast, TimezoneDialog) portal into a body-level host
 *    that the scope provides, so they are themed and never clipped. They must be rendered below a
 *    scope. Both scopes also provide useToast().
 *  - Sizing: controls are `--c-control-h` tall (48px public, 38px dashboard, at least 44px on touch
 *    screens). Text inputs never go below 16px on touch screens, so iOS does not zoom.
 *  - Motion uses `--c-dur-*` / `--c-ease`, which drop to 0 when the theme turns animations off or the
 *    visitor prefers reduced motion.
 *  - Images: the CSP allows only same-origin and data: URLs. Use readFileAsDataUrl() for previews.
 *
 * In dev, /meeting/__kit shows every component in both scopes (see src/dev/Kit.tsx for the URL
 * switches) and `VITE_MOCK_API=1 npx vite` runs the whole app against src/dev/mockApi.ts.
 */
export { Avatar, AvatarGroup } from './Avatar';
export type { AvatarGroupProps, AvatarProps, AvatarSize } from './Avatar';
export { Badge } from './Badge';
export type { BadgeProps, BadgeTone } from './Badge';
export { Button, ButtonLink, buttonClass } from './Button';
export type { ButtonLinkProps, ButtonProps, ButtonSize, ButtonVariant } from './Button';
export { Card } from './Card';
export type { CardProps } from './Card';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { ColorInput } from './ColorInput';
export type { ColorInputProps } from './ColorInput';
export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog';
export { CopyButton } from './CopyButton';
export type { CopyButtonProps } from './CopyButton';
export { Drawer } from './Drawer';
export type { DrawerProps } from './Drawer';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { Field, useFieldControl } from './Field';
export type { FieldProps } from './Field';
export { IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';
export { Input, Select, Textarea } from './Input';
export type { ControlSize, InputProps, SelectOption, SelectProps, TextareaProps } from './Input';
export { Menu } from './Menu';
export type { MenuItem, MenuProps } from './Menu';
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
export { Portal, PortalContext, PortalHost, usePortalHost } from './Portal';
export { RadioGroup } from './RadioGroup';
export type { RadioGroupProps, RadioOption } from './RadioGroup';
export { SegmentedControl } from './SegmentedControl';
export type { SegmentOption, SegmentedControlProps } from './SegmentedControl';
export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';
export { Slider } from './Slider';
export type { SliderProps } from './Slider';
export { LoadingBlock, Spinner } from './Spinner';
export type { LoadingBlockProps, SpinnerProps } from './Spinner';
export { Switch } from './Switch';
export type { SwitchProps } from './Switch';
export { TabPanel, Tabs } from './Tabs';
export type { TabItem, TabPanelProps, TabsProps } from './Tabs';
export { TimezoneDialog, TimezoneSelect } from './TimezoneSelect';
export type { TimezoneDialogProps, TimezoneSelectProps } from './TimezoneSelect';
export { ToastProvider, useToast } from './Toast';
export type { ToastApi, ToastOptions, ToastTone } from './Toast';
export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';
export { AppErrorBoundary, NotFound, RouteFallback } from './AppStates';
export { useAnchoredPosition, useDialogBehavior, useDismiss, usePresence, useScrollLock } from './overlay';
export type { Align, AnchorOptions, Side } from './overlay';
export { copyText, cx, focusableWithin, initialsOf, mergeRefs, readFileAsDataUrl, useLatest, useMediaQuery, usePrefersReducedMotion } from './util';
