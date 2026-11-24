/** The approved Lake application artwork, shared with the native app icon. */
export function LakeLogo({size=32,decorative=false,className=''}:{size?:number;decorative?:boolean;className?:string}){
 return <img className={`lake-brand-logo ${className}`} src="/brand/lake-app-icon.png" width={size} height={size} alt={decorative?'':'Lake'} aria-hidden={decorative||undefined} draggable={false}/>;
}

export function LakeWordmark({className}: {className: string}) {
  return <svg className={className} width="62" height="20" viewBox="0 0 94 30"
    fill="currentColor" role="img" aria-label="Lake" focusable="false">
    <path d="M2 2h4.6v22H21l-2.7 4.6H2z"/>
    <path fillRule="evenodd"
      d="M39.1 10h4.3v18.6h-4.3v-2.4a8.8 8.8 0 0 1-6.7 2.9c-5.5 0-9.8-4.1-9.8-9.8s4.3-9.8 9.8-9.8c2.7 0 5.2 1.1 6.7 2.9V10Zm-6.2 3.4c-3.5 0-5.9 2.5-5.9 5.9s2.4 5.9 5.9 5.9 6-2.5 6-5.9-2.5-5.9-6-5.9Z"/>
    <path d="M48 2h4.6v16.6l8.8-8.6h6l-7.9 7.9 9.1 10.7h-5.7L56.1 21l-3.5 3.4v4.2H48Z"/>
    <path fill="var(--pilot-wordmark-active,currentColor)" fillRule="evenodd"
      d="m92.4 18.8-16.2 2.7c.8 2.5 2.8 4 6.1 4 2.8 0 4.9-1.1 6.6-2.9l2.8 2.7c-2.2 2.6-5.5 4-9.5 4-6.6 0-11.1-4-11.1-9.9 0-5.8 4.4-9.9 10.7-9.9 6 0 10.2 3.8 10.6 9.3ZM75.7 18l11.5-1.9c-.8-2.1-2.6-3.4-5.3-3.4-3.3 0-5.8 2-6.2 5.3Z"/>
  </svg>;
}
