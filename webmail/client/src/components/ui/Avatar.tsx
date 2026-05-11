import type { EmailAddress } from '@/types/email'
import { initials, avatarColor } from '@/lib/utils'

interface AvatarProps {
  address: EmailAddress
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-[12px]',
  lg: 'w-10 h-10 text-[14px]',
}

export function Avatar({ address, size = 'md', className = '' }: AvatarProps) {
  const color = avatarColor(address.address)
  const text = initials(address)

  return (
    <div
      className={`${sizes[size]} rounded-full flex items-center justify-center flex-shrink-0 font-semibold select-none ${className}`}
      style={{ background: color + '33', color, border: `1px solid ${color}55` }}
      aria-label={address.name || address.address}
    >
      {text}
    </div>
  )
}
