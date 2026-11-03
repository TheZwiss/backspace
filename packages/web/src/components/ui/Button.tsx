import { forwardRef, type ButtonHTMLAttributes } from 'react';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'warning';
}
const variants = { primary: 'ui-button-primary', secondary: 'ui-button-secondary', danger: 'ui-button-danger', warning: 'ui-button-warning' };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', className = '', type = 'button', ...props }, ref) {
  return <button data-icon-motion="press" ref={ref} type={type} {...props} className={`ui-button ${variants[variant]} ${className}`} />;
});
