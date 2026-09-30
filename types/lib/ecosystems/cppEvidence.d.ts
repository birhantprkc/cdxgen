/**
 * Method to find c/c++ modules by collecting usages with atom
 *
 * @param {string} src directory
 * @param {object} options Command line options
 * @param {array} osPkgsList Array of OS pacakges represented as components
 * @param {array} epkgList Existing packages list
 */
export declare function getCppModules(src: string, options: object, osPkgsList: array, epkgList: array): {
    parentComponent: Object | {
        name: any;
        version: any;
        description: any;
        license: any;
        purl: any;
        type: string;
        "bom-ref": string;
        group?: undefined;
    } | {
        description?: undefined;
        license?: undefined;
        purl?: undefined;
        "bom-ref"?: undefined;
        group: any;
        name: any;
        version: string;
        type: string;
    } | undefined;
    pkgList: any[];
    dependenciesList: {
        ref: any;
        dependsOn: any[];
    }[];
};
//# sourceMappingURL=cppEvidence.d.ts.map