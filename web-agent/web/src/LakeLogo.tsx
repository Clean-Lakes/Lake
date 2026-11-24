/** The approved Lake application artwork, shared with the native app icon. */
export function LakeLogo({size=32,decorative=false,className=''}:{size?:number;decorative?:boolean;className?:string}){
 return <img className={`lake-brand-logo ${className}`} src="/brand/lake-app-icon.png" width={size} height={size} alt={decorative?'':'Lake'} aria-hidden={decorative||undefined} draggable={false}/>;
}

export function LakeWordmark({className}: {className: string}) {
  return <svg className={className} width="46" height="16" viewBox="0 0 86 30"
    fill="none" stroke="currentColor" strokeWidth="3.15" strokeLinecap="round" strokeLinejoin="round"
    role="img" aria-label="Lake" focusable="false">
    <path d="M4 3.4V21c0 3.4 1.7 5 5 5h3.6c2.9 0 5.3-.4 7-1.7"/>
    <path d="M39.2 12v14m0-7c0 4.2-3.2 7.2-7.5 7.2s-7.7-3-7.7-7.2 3.4-7.3 7.7-7.3 7.5 3.1 7.5 7.3Z"/>
    <path d="M46.6 3.4V26m0-5 12.2-9.2m-7 5.3 8.1 8.9"/>
    <path d="M65.4 19.2h16.2c-.3-4.7-3.4-7.5-7.8-7.5-4.9 0-8.7 3.1-8.7 7.7 0 4.4 3.7 7 8.4 7 2.9 0 5.1-.9 7-2.7"/>
  </svg>;
}
