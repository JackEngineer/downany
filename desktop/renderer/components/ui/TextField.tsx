import { forwardRef, type InputHTMLAttributes } from "react";

import { Icon, type IconName } from "./Icon";

export interface TextFieldProps
  extends InputHTMLAttributes<HTMLInputElement> {
  leadingIcon?: IconName;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ leadingIcon, className = "", ...props }, ref) {
    return (
      <label className={`ui-text-field ${className}`.trim()}>
        {leadingIcon ? <Icon name={leadingIcon} size={16} /> : null}
        <input ref={ref} {...props} />
      </label>
    );
  },
);
