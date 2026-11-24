/** The approved Lake application artwork, shared with the native app icon. */
export function LakeLogo({size=32,decorative=false,className=''}:{size?:number;decorative?:boolean;className?:string}){
 return <img className={`lake-brand-logo ${className}`} src="/brand/lake-app-icon.png" width={size} height={size} alt={decorative?'':'Lake'} aria-hidden={decorative||undefined} draggable={false}/>;
}
