import React from 'react';
import { Tooltip } from './Tooltip';

interface UsernameProps {
  username: string;
  className?: string;
  style?: React.CSSProperties;
}

export function Username({ username, className, style }: UsernameProps) {
  const atIndex = username.indexOf('@');
  if (atIndex === -1) {
    return <span className={className} style={style}>{username}</span>;
  }
  const name = username.slice(0, atIndex);
  const domain = username.slice(atIndex + 1);
  return (
    <Tooltip content={username} position="top">
      <span className={className} style={style}>
        {name}
        <span className="text-txt-tertiary text-[0.8em] ml-0.5 font-normal">@{domain}</span>
      </span>
    </Tooltip>
  );
}
