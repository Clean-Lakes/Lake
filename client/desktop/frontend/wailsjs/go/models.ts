export namespace main {
	
	export class ImageAttachment {
	    name?: string;
	    mime_type: string;
	    data: string;
	
	    static createFrom(source: any = {}) {
	        return new ImageAttachment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.mime_type = source["mime_type"];
	        this.data = source["data"];
	    }
	}
	export class WorkflowRunRequest {
	    name: string;
	    resource?: string;
	    bindings?: Record<string, string>;
	    targets?: string[];
	
	    static createFrom(source: any = {}) {
	        return new WorkflowRunRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.resource = source["resource"];
	        this.bindings = source["bindings"];
	        this.targets = source["targets"];
	    }
	}

}

