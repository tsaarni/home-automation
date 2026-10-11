// Side-effect imports to register official Material 3 custom elements
import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/button/elevated-button.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/switch/switch.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/chips/chip-set.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/chips/assist-chip.js";
import "@material/web/dialog/dialog.js";
import "@material/web/divider/divider.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/icon/icon.js";
import "@material/web/elevation/elevation.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/tabs/secondary-tab.js";
import "@material/web/progress/circular-progress.js";

// Type augmentations for JSX so React 19 recognises <md-*> elements seamlessly
type MdElementProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  disabled?: boolean;
  name?: string;
  value?: string;
  href?: string;
  selected?: boolean;
  type?: string;
  [key: string]: unknown;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "md-filled-button": MdElementProps;
      "md-filled-tonal-button": MdElementProps;
      "md-outlined-button": MdElementProps;
      "md-text-button": MdElementProps;
      "md-elevated-button": MdElementProps;
      "md-icon-button": MdElementProps;
      "md-switch": MdElementProps & { selected?: boolean; icons?: boolean; showOnlySelectedIcon?: boolean };
      "md-checkbox": MdElementProps & { checked?: boolean };
      "md-outlined-text-field": MdElementProps & { label?: string; placeholder?: string; type?: string; min?: number; max?: number; step?: number };
      "md-outlined-select": MdElementProps & { label?: string };
      "md-select-option": MdElementProps & { headline?: string };
      "md-chip-set": MdElementProps;
      "md-filter-chip": MdElementProps & { label?: string; elevated?: boolean };
      "md-assist-chip": MdElementProps & { label?: string; elevated?: boolean };
      "md-dialog": MdElementProps & { open?: boolean; type?: string };
      "md-divider": MdElementProps & { inset?: boolean };
      "md-list": MdElementProps;
      "md-list-item": MdElementProps & { headline?: string; supportingText?: string; trailingSupportingText?: string };
      "md-icon": MdElementProps;
      "md-elevation": MdElementProps;
      "md-tabs": MdElementProps & { activeTabIndex?: number };
      "md-primary-tab": MdElementProps;
      "md-secondary-tab": MdElementProps;
      "md-circular-progress": MdElementProps & { indeterminate?: boolean };
    }
  }
}
